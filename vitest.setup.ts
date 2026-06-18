import "@testing-library/jest-dom/vitest";

// jsdom doesn't fully implement the native <dialog> modal methods, so components that use a native
// modal dialog (the composer, the calendar event slide-over) can't render under tests. Polyfill only
// the gaps, reflecting the open state via the `open` property (which mirrors to the attribute).
if (typeof HTMLDialogElement !== "undefined" && typeof document !== "undefined") {
  const proto = HTMLDialogElement.prototype;

  // Feature-detect showModal rather than force-overwriting it: jsdom DEFINES showModal but it throws
  // "Not implemented", so a plain `??=` wouldn't replace it — yet blindly overwriting would clobber a
  // real implementation (a future jsdom, or another env). Probe a CONNECTED dialog (showModal throws
  // InvalidStateError on a detached element even in a correct impl, so the probe must be in the DOM).
  let showModalWorks = false;
  const probe = document.createElement("dialog");
  document.body.appendChild(probe);
  try {
    probe.showModal();
    probe.close();
    showModalWorks = true;
  } catch {
    showModalWorks = false;
  } finally {
    probe.remove();
  }
  if (!showModalWorks) {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
  }

  // show()/close() exist in jsdom; only fill them if a host lacks them (don't clobber a real impl).
  proto.show ??= function show(this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close ??= function close(this: HTMLDialogElement, returnValue?: string) {
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event("close"));
  };
}
