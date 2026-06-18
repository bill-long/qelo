import "@testing-library/jest-dom/vitest";

// jsdom doesn't fully implement the native <dialog> modal methods, so components that use a native
// modal dialog (the composer, the calendar event slide-over) can't render under tests. Polyfill the
// gaps minimally, reflecting the open state via the `open` property (which mirrors to the attribute).
// Guarded on the constructor existing, and we DON'T clobber a real `show`/`close` (only fill if
// missing) — but `showModal` must be force-replaced: jsdom DOES define it and it throws
// "Not implemented", so `??=` wouldn't override it.
if (typeof HTMLDialogElement !== "undefined") {
  const proto = HTMLDialogElement.prototype;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  proto.show ??= function show(this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close ??= function close(this: HTMLDialogElement, returnValue?: string) {
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event("close"));
  };
}
