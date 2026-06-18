import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement the native <dialog> modal methods (showModal/close), so components that use
// a native modal dialog (the composer, the calendar event slide-over) can't render under tests.
// Polyfill them minimally: reflect the open state via the `open` property (which mirrors to the
// attribute) and fire `close` — all the components + testing-library queries rely on.
const dialogProto = HTMLDialogElement.prototype;
dialogProto.showModal = function showModal(this: HTMLDialogElement) {
  this.open = true;
};
dialogProto.show = function show(this: HTMLDialogElement) {
  this.open = true;
};
dialogProto.close = function close(this: HTMLDialogElement, returnValue?: string) {
  this.open = false;
  if (returnValue !== undefined) this.returnValue = returnValue;
  this.dispatchEvent(new Event("close"));
};
