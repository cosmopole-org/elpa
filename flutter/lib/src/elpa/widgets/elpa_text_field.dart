/// [ElpaTextField] — a text input whose editing state lives on the Flutter side.
///
/// Controlled inputs are awkward across the Elpa pipe: echoing every keystroke
/// back to the VM and re-patching the field fights the platform's own editing
/// (cursor jumps, IME composition breaks). So this widget is **uncontrolled** —
/// it owns its [TextEditingController] and only reports semantic events to the
/// app:
///
/// * `onChanged` — fired as the user types, carrying the current `value`;
/// * `onSubmitted` — fired on the keyboard action, carrying the final `value`;
///   if `clearOnSubmit` is set (the messenger composer does), the field empties
///   itself locally so the next message starts fresh without a round-trip.
///
/// A `value` prop is treated as a *seed/override*: the field adopts it only when
/// it actually differs from the current text (so a scope rebuild that carries the
/// same value never clobbers what the user is typing). This lets the app reset or
/// prefill the field deliberately while keeping normal typing local and smooth.
library;

import 'package:flutter/material.dart';

/// Signature for reporting a field event (a tap-like dispatch carrying the text).
typedef ElpaFieldEvent = void Function(String value);

class ElpaTextField extends StatefulWidget {
  const ElpaTextField({
    super.key,
    this.value = '',
    this.hint = '',
    this.obscure = false,
    this.clearOnSubmit = false,
    this.clearNonce = 0,
    this.minLines = 1,
    this.maxLines = 6,
    this.fillColor,
    this.textColor,
    this.hintColor,
    this.radius = 0,
    this.onChanged,
    this.onSubmitted,
  });

  final String value;
  final String hint;
  final bool obscure;
  final bool clearOnSubmit;

  /// A monotonic counter: whenever it changes, the field clears itself. This is
  /// the app's explicit "empty the composer" channel (e.g. after the on-screen
  /// send button), decoupled from `value` so it never fights live typing.
  final int clearNonce;

  final int minLines;
  final int maxLines;
  final Color? fillColor;
  final Color? textColor;
  final Color? hintColor;
  final double radius;
  final ElpaFieldEvent? onChanged;
  final ElpaFieldEvent? onSubmitted;

  @override
  State<ElpaTextField> createState() => _ElpaTextFieldState();
}

class _ElpaTextFieldState extends State<ElpaTextField> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.value);
  }

  @override
  void didUpdateWidget(covariant ElpaTextField oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Adopt an externally-set value only when it diverges from what we hold, so a
    // rebuild carrying the same seed never interrupts in-progress editing.
    if (widget.value != oldWidget.value && widget.value != _controller.text) {
      _controller.text = widget.value;
    }
    // An explicit clear request (the composer's send button) empties the field.
    if (widget.clearNonce != oldWidget.clearNonce) {
      _controller.clear();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _handleSubmit(String text) {
    widget.onSubmitted?.call(text);
    if (widget.clearOnSubmit) _controller.clear();
  }

  @override
  Widget build(BuildContext context) {
    final hasFill = widget.fillColor != null;
    return TextField(
      controller: _controller,
      obscureText: widget.obscure,
      minLines: widget.obscure ? 1 : widget.minLines,
      maxLines: widget.obscure ? 1 : widget.maxLines,
      style: widget.textColor == null ? null : TextStyle(color: widget.textColor),
      textInputAction:
          widget.maxLines > 1 ? TextInputAction.newline : TextInputAction.send,
      onChanged: widget.onChanged,
      onSubmitted: _handleSubmit,
      decoration: InputDecoration(
        isDense: true,
        hintText: widget.hint,
        hintStyle: widget.hintColor == null ? null : TextStyle(color: widget.hintColor),
        filled: hasFill,
        fillColor: widget.fillColor,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(widget.radius),
          borderSide: widget.radius > 0 ? BorderSide.none : const BorderSide(),
        ),
        enabledBorder: widget.radius > 0
            ? OutlineInputBorder(
                borderRadius: BorderRadius.circular(widget.radius),
                borderSide: BorderSide.none,
              )
            : null,
      ),
    );
  }
}
