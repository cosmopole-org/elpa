//! Decoded program representation.
//!
//! The executor used to walk the raw bytecode byte-by-byte on *every* step of
//! *every* frame: re-reading each opcode, re-parsing every length-prefixed
//! identifier / object key / parameter name (a fresh UTF-8 validation **and**
//! `String` allocation each time), and rebuilding each literal `Val` from its
//! bytes. For a program whose render path re-runs dozens of times a second over
//! thousands of operations this re-decoding dominated the per-frame cost.
//!
//! [`DecodedProgram`] lifts that work out of the hot loop. At construction the
//! whole byte stream is decoded **once** into a flat, addressable list of
//! [`Unit`]s — one object per opcode / immediate the interpreter ever reads —
//! with every operand pre-parsed: literals prebuilt as [`Val`], names interned
//! as `Rc<str>`/`Rc<Vec<String>>` (shared, never re-allocated), counts and
//! branch data as plain integers. The interpreter then *traverses* this
//! structure instead of re-parsing bytes, which is what makes repeated
//! execution of the same program markedly cheaper.
//!
//! ## Addressing
//!
//! The decoded units are addressed by the **same byte offsets** the compiler
//! baked into the bytecode (jump targets, function/scope bounds, branch
//! pointers). [`DecodedProgram::index_at`] maps each such offset to its unit
//! index, so the interpreter keeps its existing byte-offset program counter and
//! all of the compiler's offset arithmetic is preserved untouched — only the
//! *reads* change from "parse bytes" to "index a pre-decoded unit". This keeps
//! the control-flow semantics (loops, the if/else chain, switch, calls, the
//! pause/resume continuation) byte-for-byte identical to the original
//! interpreter while removing the per-step parsing and allocation.
//!
//! The grammar decoded here mirrors exactly what `compiler::serialize_expr`,
//! `compiler::serialize_condition_chain` and `compiler::compile_ast` emit; the
//! two must stay in lock-step.

use std::rc::Rc;

use crate::sdk::data::{Payload, Val};

/// One decoded operation / immediate, as the interpreter reads it. Each variant
/// carries its operands already parsed, so executing it never touches the raw
/// bytes again. Cheap to clone (scalars are copied; names/parameter lists are
/// `Rc` pointer bumps), which the dispatch loop relies on.
#[derive(Clone)]
pub enum UnitKind {
    /// A no-op byte (`0x00` padding for an empty body, or any unknown opcode —
    /// matched the interpreter's old `_ => {}` arm).
    Nop,

    // ---- value-producing units (what the old `extract_val` returned) --------
    /// A scalar or string literal (`typ` 1..=7). Cloned to produce the value.
    Lit(Val),
    /// An identifier reference (`0x0b`); resolved against the scope chain /
    /// builtins / the `askHost` seam at run time.
    Ident(Rc<str>),
    /// A function *literal* (`0x0a`). Closes over the live lexical environment
    /// when evaluated.
    FuncLit { start: usize, end: usize, params: Rc<Vec<String>> },

    // ---- operator / control units with no inline operand --------------------
    /// `0x0c` — indexer (`target[index]`).
    Indexer,
    /// `0x0d` — function / host call.
    Call,
    /// `0xfc` — boolean `!`.
    Not,
    /// `0xfd` — `cast` to a named target type (the type name follows as a
    /// [`UnitKind::Str`]).
    Cast,
    /// `0xf0..=0xfb` — an arithmetic / comparison operator, normalised to the
    /// `1..=12` id the interpreter switches on.
    Arith(i16),
    /// `0x14` — `return`.
    Return,
    /// `0x11` — `while`/`for` loop head.
    Loop,
    /// `0x12` — `switch`.
    Switch,
    /// `0x16` — low-level conditional branch.
    CondBranch,

    // ---- statement units with baked operands --------------------------------
    /// `0x0e` — `let`/`const`/`var` of a simple name (value expression follows).
    DefineVar(Rc<str>),
    /// `0x0f` — assignment. `kind` is 1 for a plain identifier target and 2 for
    /// an indexed target (`a[i] = v` / `a.b = v`, whose index expression then
    /// precedes the value expression).
    AssignVar { name: Rc<str>, kind: i16 },
    /// `0x10` — head of one arm of an if/else chain. `has_condition` is false
    /// for the trailing unconditional `else`.
    IfHead { has_condition: bool },
    /// `0x15` — unconditional jump to a byte offset.
    Jump(usize),
    /// `0x08` — object-literal head (type id + property count).
    ObjHead { typ: i64, props_len: i32 },
    /// `0x09` — array-literal head (element count).
    ArrHead { len: i32 },
    /// `0x13` — function definition (hoisted, body follows in the stream).
    FuncDef {
        name: Rc<str>,
        params: Rc<Vec<String>>,
        frees: Rc<Vec<String>>,
        start: usize,
        end: usize,
    },

    // ---- bare immediates consumed by a later state transition ---------------
    /// A 32-bit immediate (e.g. a call's argument count).
    I32(i32),
    /// A 64-bit immediate (e.g. a branch / body / case offset).
    I64(i64),
    /// A length-prefixed string immediate (e.g. a `cast` target type).
    Str(Rc<str>),
}

/// A decoded unit plus the number of raw bytes it occupied, so the interpreter
/// can advance its byte-offset program counter exactly as before.
#[derive(Clone)]
pub struct Unit {
    pub kind: UnitKind,
    pub len: u32,
}

/// The whole program decoded once into addressable [`Unit`]s.
pub struct DecodedProgram {
    /// Decoded units in byte order.
    pub units: Vec<Unit>,
    /// Byte offset → index into [`units`]. `u32::MAX` marks an offset that is
    /// interior to a unit (never a valid program-counter landing spot).
    pub index_at: Vec<u32>,
}

const NONE: u32 = u32::MAX;

impl DecodedProgram {
    /// Decode an entire bytecode program. Mirrors the compiler's emission
    /// grammar; see the module docs.
    pub fn decode(bytes: &[u8]) -> DecodedProgram {
        let mut d = Decoder { bytes, units: Vec::new(), index_at: vec![NONE; bytes.len()] };
        if !bytes.is_empty() {
            d.decode_stmt_seq(0, bytes.len());
        }
        DecodedProgram { units: d.units, index_at: d.index_at }
    }

    /// The unit index at byte offset `off`. The interpreter only ever asks for
    /// offsets that are real unit starts (opcode positions, immediates reached
    /// in order, control-flow targets the compiler aligned to statement
    /// boundaries), so this is always a valid index in practice.
    #[inline]
    pub fn index_at(&self, off: usize) -> usize {
        self.index_at[off] as usize
    }
}

struct Decoder<'a> {
    bytes: &'a [u8],
    units: Vec<Unit>,
    index_at: Vec<u32>,
}

impl<'a> Decoder<'a> {
    #[inline]
    fn emit(&mut self, off: usize, kind: UnitKind, len: usize) {
        self.index_at[off] = self.units.len() as u32;
        self.units.push(Unit { kind, len: len as u32 });
    }

    #[inline]
    fn read_i16(&self, p: usize) -> i16 {
        i16::from_be_bytes(self.bytes[p..p + 2].try_into().unwrap())
    }
    #[inline]
    fn read_i32(&self, p: usize) -> i32 {
        i32::from_be_bytes(self.bytes[p..p + 4].try_into().unwrap())
    }
    #[inline]
    fn read_i64(&self, p: usize) -> i64 {
        i64::from_be_bytes(self.bytes[p..p + 8].try_into().unwrap())
    }
    #[inline]
    fn read_f32(&self, p: usize) -> f32 {
        f32::from_be_bytes(self.bytes[p..p + 4].try_into().unwrap())
    }
    #[inline]
    fn read_f64(&self, p: usize) -> f64 {
        f64::from_be_bytes(self.bytes[p..p + 8].try_into().unwrap())
    }
    /// Read a length-prefixed string at `p`, returning it and the total bytes
    /// consumed (the 4-byte length plus the payload).
    fn read_str(&self, p: usize) -> (String, usize) {
        let len = self.read_i32(p) as usize;
        let s = String::from_utf8(self.bytes[p + 4..p + 4 + len].to_vec()).unwrap();
        (s, 4 + len)
    }

    // ---- expressions (mirror of `serialize_expr` / `extract_val`) -----------

    /// Decode one expression starting at `pos`; return the offset just past it.
    fn decode_value(&mut self, pos: usize) -> usize {
        let tag = self.bytes[pos];
        match tag {
            1 => {
                self.emit(pos, UnitKind::Lit(Val::new(1, Payload::from(self.read_i16(pos + 1)))), 3);
                pos + 3
            }
            2 => {
                self.emit(pos, UnitKind::Lit(Val::new(2, Payload::from(self.read_i32(pos + 1)))), 5);
                pos + 5
            }
            3 => {
                self.emit(pos, UnitKind::Lit(Val::new(3, Payload::from(self.read_i64(pos + 1)))), 9);
                pos + 9
            }
            4 => {
                self.emit(pos, UnitKind::Lit(Val::new(4, Payload::from(self.read_f32(pos + 1)))), 5);
                pos + 5
            }
            5 => {
                self.emit(pos, UnitKind::Lit(Val::new(5, Payload::from(self.read_f64(pos + 1)))), 9);
                pos + 9
            }
            6 => {
                let b = self.bytes[pos + 1] == 0x01;
                self.emit(pos, UnitKind::Lit(Val::new(6, Payload::from(b))), 2);
                pos + 2
            }
            7 => {
                let (s, consumed) = self.read_str(pos + 1);
                self.emit(pos, UnitKind::Lit(Val::new(7, Payload::from(s))), 1 + consumed);
                pos + 1 + consumed
            }
            0x0a => {
                // Function literal: start, end, param count, params.
                let start = self.read_i64(pos + 1) as usize;
                let end = self.read_i64(pos + 9) as usize;
                let param_count = self.read_i32(pos + 17) as usize;
                let mut p = pos + 21;
                let mut params = Vec::with_capacity(param_count);
                for _ in 0..param_count {
                    let (name, consumed) = self.read_str(p);
                    params.push(name);
                    p += consumed;
                }
                self.emit(
                    pos,
                    UnitKind::FuncLit { start, end, params: Rc::new(params) },
                    p - pos,
                );
                p
            }
            0x0b => {
                let (name, consumed) = self.read_str(pos + 1);
                self.emit(pos, UnitKind::Ident(Rc::from(name.as_str())), 1 + consumed);
                pos + 1 + consumed
            }
            0x0c => {
                // Indexer: opcode, then target expression, then index expression.
                self.emit(pos, UnitKind::Indexer, 1);
                let after_target = self.decode_value(pos + 1);
                self.decode_value(after_target)
            }
            0xfc => {
                self.emit(pos, UnitKind::Not, 1);
                self.decode_value(pos + 1)
            }
            0xfd => {
                // Cast: opcode, value expression, then the target-type string.
                self.emit(pos, UnitKind::Cast, 1);
                let after_val = self.decode_value(pos + 1);
                let (ty, consumed) = self.read_str(after_val);
                self.emit(after_val, UnitKind::Str(Rc::from(ty.as_str())), consumed);
                after_val + consumed
            }
            0xf0..=0xfb => {
                self.emit(pos, UnitKind::Arith((tag - 0xf0 + 1) as i16), 1);
                let after_op1 = self.decode_value(pos + 1);
                self.decode_value(after_op1)
            }
            0x0d => self.decode_call(pos),
            8 => self.decode_object(pos),
            9 => self.decode_array(pos),
            other => panic!("program decode: unknown value tag 0x{other:02x} at offset {pos}"),
        }
    }

    /// Decode a call expression/statement: opcode, callee, arg count, args.
    fn decode_call(&mut self, pos: usize) -> usize {
        self.emit(pos, UnitKind::Call, 1);
        let mut p = self.decode_value(pos + 1); // callee
        let argc = self.read_i32(p);
        self.emit(p, UnitKind::I32(argc), 4);
        p += 4;
        for _ in 0..argc {
            p = self.decode_value(p);
        }
        p
    }

    fn decode_object(&mut self, pos: usize) -> usize {
        let typ = self.read_i64(pos + 1);
        let props_len = self.read_i32(pos + 9);
        self.emit(pos, UnitKind::ObjHead { typ, props_len }, 1 + 8 + 4);
        let mut p = pos + 13;
        for _ in 0..props_len {
            p = self.decode_value(p); // key (a tag-7 string literal)
            p = self.decode_value(p); // value
        }
        p
    }

    fn decode_array(&mut self, pos: usize) -> usize {
        let len = self.read_i32(pos + 1);
        self.emit(pos, UnitKind::ArrHead { len }, 1 + 4);
        let mut p = pos + 5;
        for _ in 0..len {
            p = self.decode_value(p);
        }
        p
    }

    // ---- statements (mirror of `compile_ast`) -------------------------------

    fn decode_stmt_seq(&mut self, start: usize, end: usize) {
        let mut pos = start;
        while pos < end {
            pos = self.decode_stmt(pos);
        }
    }

    /// Decode one statement starting at `pos`; return the offset just past its
    /// entire extent (so the linear scan resumes at the next statement and
    /// never re-decodes an already-decoded body).
    fn decode_stmt(&mut self, pos: usize) -> usize {
        let tag = self.bytes[pos];
        match tag {
            0x15 => {
                let dest = self.read_i64(pos + 1) as usize;
                self.emit(pos, UnitKind::Jump(dest), 1 + 8);
                pos + 9
            }
            0x16 => {
                self.emit(pos, UnitKind::CondBranch, 1);
                let mut p = self.decode_value(pos + 1); // condition
                let tb = self.read_i64(p);
                self.emit(p, UnitKind::I64(tb), 8);
                p += 8;
                let fb = self.read_i64(p);
                self.emit(p, UnitKind::I64(fb), 8);
                p += 8;
                p
            }
            0x0d => self.decode_call(pos),
            0x14 => {
                self.emit(pos, UnitKind::Return, 1);
                self.decode_value(pos + 1)
            }
            0x10 => self.decode_if_chain(pos),
            0x11 => {
                // loop: opcode, condition, body_start, body_end, branch_after, body.
                self.emit(pos, UnitKind::Loop, 1);
                let mut p = self.decode_value(pos + 1); // condition
                let body_start = self.read_i64(p) as usize;
                self.emit(p, UnitKind::I64(body_start as i64), 8);
                p += 8;
                let body_end = self.read_i64(p) as usize;
                self.emit(p, UnitKind::I64(body_end as i64), 8);
                p += 8;
                let branch_after = self.read_i64(p);
                self.emit(p, UnitKind::I64(branch_after), 8);
                p += 8;
                debug_assert_eq!(p, body_start);
                self.decode_stmt_seq(body_start, body_end);
                body_end
            }
            0x12 => self.decode_switch(pos),
            0x13 => self.decode_funcdef(pos),
            0x0e => {
                // definition: 0x0e, 0x0b discriminator, name, value expression.
                let (name, consumed) = self.read_str(pos + 2);
                self.emit(pos, UnitKind::DefineVar(Rc::from(name.as_str())), 2 + consumed);
                self.decode_value(pos + 2 + consumed)
            }
            0x0f => {
                // assignment: 0x0f, discriminator (0x0b ident / 0x0c index), name,
                // [index expression], value expression.
                let disc = self.bytes[pos + 1];
                let kind = if disc == 0x0c { 2 } else { 1 };
                let (name, consumed) = self.read_str(pos + 2);
                self.emit(pos, UnitKind::AssignVar { name: Rc::from(name.as_str()), kind }, 2 + consumed);
                let mut p = pos + 2 + consumed;
                if kind == 2 {
                    p = self.decode_value(p); // index expression
                }
                self.decode_value(p) // value expression
            }
            // `0x00` (empty body) and anything unknown: a no-op, exactly like the
            // interpreter's old fall-through arm.
            _ => {
                self.emit(pos, UnitKind::Nop, 1);
                pos + 1
            }
        }
    }

    /// Decode one if/else-if/else chain starting at `pos`; return the offset
    /// just past the whole chain (its shared `branch_after`).
    fn decode_if_chain(&mut self, pos: usize) -> usize {
        let conditioned = self.bytes[pos + 1] == 0x01;
        self.emit(pos, UnitKind::IfHead { has_condition: conditioned }, 2);
        let mut p = pos + 2;
        if conditioned {
            p = self.decode_value(p); // condition
        }
        let body_start = self.read_i64(p) as usize;
        self.emit(p, UnitKind::I64(body_start as i64), 8);
        p += 8;
        let body_end = self.read_i64(p) as usize;
        self.emit(p, UnitKind::I64(body_end as i64), 8);
        p += 8;
        if conditioned {
            let next = self.read_i64(p);
            self.emit(p, UnitKind::I64(next), 8);
            p += 8;
        }
        let branch_after = self.read_i64(p) as usize;
        self.emit(p, UnitKind::I64(branch_after as i64), 8);
        p += 8;
        debug_assert_eq!(p, body_start);
        self.decode_stmt_seq(body_start, body_end);
        // The trailing else-if / else arm (if any) lives between this arm's body
        // and the chain's shared end.
        if body_end < branch_after {
            self.decode_if_chain(body_end);
        }
        branch_after
    }

    fn decode_switch(&mut self, pos: usize) -> usize {
        self.emit(pos, UnitKind::Switch, 1);
        let mut p = self.decode_value(pos + 1); // switch value
        let branch_after = self.read_i64(p);
        self.emit(p, UnitKind::I64(branch_after), 8);
        p += 8;
        let case_count = self.read_i64(p);
        self.emit(p, UnitKind::I64(case_count), 8);
        p += 8;
        for _ in 0..case_count {
            p = self.decode_value(p); // case value
            let case_start = self.read_i64(p) as usize;
            self.emit(p, UnitKind::I64(case_start as i64), 8);
            p += 8;
            let case_end = self.read_i64(p) as usize;
            self.emit(p, UnitKind::I64(case_end as i64), 8);
            p += 8;
            debug_assert_eq!(p, case_start);
            self.decode_stmt_seq(case_start, case_end);
            p = case_end;
        }
        branch_after as usize
    }

    fn decode_funcdef(&mut self, pos: usize) -> usize {
        let mut p = pos + 1;
        let (name, consumed) = self.read_str(p);
        p += consumed;
        let param_count = self.read_i32(p) as usize;
        p += 4;
        let mut params = Vec::with_capacity(param_count);
        for _ in 0..param_count {
            let (n, c) = self.read_str(p);
            params.push(n);
            p += c;
        }
        let free_count = self.read_i32(p) as usize;
        p += 4;
        let mut frees = Vec::with_capacity(free_count);
        for _ in 0..free_count {
            let (n, c) = self.read_str(p);
            frees.push(n);
            p += c;
        }
        let func_start = self.read_i64(p) as usize;
        p += 8;
        let func_end = self.read_i64(p) as usize;
        p += 8;
        debug_assert_eq!(p, func_start);
        self.emit(
            pos,
            UnitKind::FuncDef {
                name: Rc::from(name.as_str()),
                params: Rc::new(params),
                frees: Rc::new(frees),
                start: func_start,
                end: func_end,
            },
            p - pos,
        );
        self.decode_stmt_seq(func_start, func_end);
        func_end
    }
}
