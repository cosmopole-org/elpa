use std::{cell::RefCell, rc::Rc};

use crate::sdk::data::{Payload, Val, ValGroup, ValMap};

pub struct Scope {
    pub tag: String,
    pub memory: Rc<RefCell<ValGroup>>,
    pub frozen_start: usize,
    pub frozen_end: usize,
    pub frozen_pointer: usize,
}
impl Scope {
    pub fn new(
        tag: String,
        initial_pointer: usize,
        frozen_start: usize,
        frozen_end: usize,
    ) -> Self {
        Scope {
            tag,
            memory: Rc::new(RefCell::new(ValGroup::new_empty())),
            frozen_pointer: initial_pointer,
            frozen_start,
            frozen_end,
        }
    }
    pub fn new_with_args(
        tag: String,
        initial_pointer: usize,
        frozen_start: usize,
        frozen_end: usize,
        args: ValMap,
    ) -> Self {
        Scope {
            tag,
            memory: Rc::new(RefCell::new(ValGroup::new(args))),
            frozen_pointer: initial_pointer,
            frozen_start,
            frozen_end,
        }
    }
    pub fn update_frozen_pointer(&mut self, pointer: usize) {
        self.frozen_pointer = pointer;
    }
    pub fn update_initial_pointer_info(
        &mut self,
        pointer: usize,
        frozen_start: usize,
        frozen_end: usize,
    ) {
        self.frozen_pointer = pointer;
        self.frozen_start = frozen_start;
        self.frozen_end = frozen_end;
    }
    pub fn find_val(&self, name: &str) -> Val {
        let v = self.memory.borrow();
        match v.data.get(name) {
            None => Val::new(0, Payload::Null),
            Some(val) => val.clone(),
        }
    }
    pub fn update_val(&mut self, name: String, val: Val) -> bool {
        let mut v = self.memory.borrow_mut();
        if v.data.contains_key(&name) {
            v.data.insert(name, val);
            return true;
        }
        false
    }
    pub fn define_val(&mut self, name: String, val: Val) {
        let mut v = self.memory.borrow_mut();
        v.data.insert(name, val);
    }
}

pub struct Context {
    pub memory: Vec<Rc<RefCell<Scope>>>,
}

impl Context {
    pub fn new() -> Self {
        Context { memory: vec![] }
    }
    pub fn push_scope(
        &mut self,
        tag: String,
        inital_pointer: usize,
        frozen_start: usize,
        frozen_end: usize,
    ) {
        self.memory.push(Rc::new(RefCell::new(Scope::new(
            tag,
            inital_pointer,
            frozen_start,
            frozen_end,
        ))));
    }
    pub fn push_scope_with_args(
        &mut self,
        tag: String,
        inital_pointer: usize,
        frozen_start: usize,
        frozen_end: usize,
        args: ValMap,
    ) {
        self.memory.push(Rc::new(RefCell::new(Scope::new_with_args(
            tag,
            inital_pointer,
            frozen_start,
            frozen_end,
            args,
        ))));
    }
    pub fn pop_scope(&mut self) {
        self.memory.pop();
    }
    pub fn get_scope(&mut self, index: usize) -> Rc<RefCell<Scope>> {
        self.memory.get(index).unwrap().clone()
    }
    pub fn find_val_globally(&mut self, name: &str) -> Val {
        for scope in self.memory.iter().rev() {
            let val = scope.borrow().find_val(name);
            if !val.is_empty() {
                return val;
            }
        }
        Val::new(0, Payload::Null)
    }
    pub fn define_val_globally(&mut self, name: String, val: Val) {
        self.memory.last().unwrap().borrow_mut().define_val(name, val);
    }
    pub fn update_val_globally(&mut self, name: String, val: Val) {
        // Walk scopes inner→outer; the first that already binds `name` takes the
        // new value. Probe with a borrow (no clone of name or val) and move the
        // owned pair into exactly one `insert`, instead of cloning both for every
        // scope tried as the previous `update_val` loop did.
        for scope in self.memory.iter().rev() {
            if scope.borrow().memory.borrow().data.contains_key(&name) {
                scope.borrow().memory.borrow_mut().data.insert(name, val);
                return;
            }
        }
        self.memory.last().unwrap().borrow_mut().define_val(name, val);
    }
    pub fn find_val_in_last_scope(&mut self, name: &str) -> Val {
        self.memory.last().unwrap().borrow().find_val(name)
    }
    pub fn find_val_in_first_scope(&mut self, name: &str) -> Val {
        self.memory.first().unwrap().borrow().find_val(name)
    }
}
