import { useState } from "react";
import { toast } from "sonner";
import { prepareShareFile, canShareFile, shareFileNow, downloadFile } from "@/lib/pdf";

/** Drives a "Share PDF" button that actually works on Safari.
 *
 * Generating the PDF is an async server round trip, and Safari silently
 * blocks navigator.share() once too much time has passed since the click
 * that triggered it — so calling share() right after that await works some
 * of the time and silently fails the rest, depending on how long the render
 * happened to take (this is why the old single-click Share button was
 * reported as "sometimes works, sometimes errors").
 *
 * Fix: split into two clicks. The first prepares the file and flips
 * `shareReady` on; the caller should highlight the button so the user
 * notices to tap it again. That second tap is a direct, fresh user gesture,
 * so Safari reliably allows the share sheet to open.
 */
export function useShareablePdf(itemLabel: string) {
  const [shareReady, setShareReady] = useState<File | null>(null);

  const share = async (
    el: HTMLElement,
    filename: string,
    orientation?: "portrait" | "landscape",
    pageWidthMm?: number,
  ) => {
    if (shareReady) {
      const file = shareReady;
      setShareReady(null);
      const result = await shareFileNow(file);
      if (result === "shared") toast.success(`${itemLabel} shared`);
      else if (result === "failed") {
        downloadFile(file);
        toast.info("Sharing isn't supported here — PDF downloaded instead");
      }
      return;
    }
    const file = await prepareShareFile(el, filename, orientation, pageWidthMm);
    if (!canShareFile(file)) {
      downloadFile(file);
      toast.info("Sharing isn't supported here — PDF downloaded instead");
      return;
    }
    setShareReady(file);
    toast.info("PDF ready — tap Share again to send");
  };

  return { shareReady, share, resetShare: () => setShareReady(null) };
}
