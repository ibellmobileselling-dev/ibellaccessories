import { useEffect, useRef, useState } from "react";
import { auth } from "@/lib/firebase";
import {
  getWhatsAppStatusServerFn,
  disconnectWhatsAppServerFn,
  type WhatsAppStatus,
} from "@/lib/whatsappAdmin";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { MessageCircle, CheckCircle2, Loader2 } from "lucide-react";

export function WhatsAppSection() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  // Poll fast while linking (status changes quickly / QR needs to look
  // fresh), slow down once idle or connected — no point hammering the
  // service once there's nothing changing.
  const pollMs = status?.status === "qr" ? 3000 : 8000;
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const callerIdToken = await auth.currentUser?.getIdToken();
        if (!callerIdToken) throw new Error("Not signed in");
        const result = await getWhatsAppStatusServerFn({ data: { callerIdToken } });
        if (cancelled) return;
        setStatus(result);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Could not reach the WhatsApp service");
      } finally {
        if (!cancelled) timerRef.current = setTimeout(poll, pollMs);
      }
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
    };
  }, [pollMs]);

  const disconnect = async () => {
    if (!confirm("Disconnect WhatsApp? You'll need to scan a new QR code to reconnect.")) return;
    setDisconnecting(true);
    try {
      const callerIdToken = await auth.currentUser?.getIdToken();
      if (!callerIdToken) throw new Error("Not signed in");
      await disconnectWhatsAppServerFn({ data: { callerIdToken } });
      toast.success("WhatsApp disconnected");
      setStatus({ status: "waiting" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  if (loadError) {
    return (
      <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50/60 border border-amber-100 rounded-md px-3 py-2.5">
        <MessageCircle className="h-4 w-4 shrink-0 mt-0.5" />
        <p>{loadError}</p>
      </div>
    );
  }

  if (!status || status.status === "waiting") {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Starting WhatsApp connection…
      </div>
    );
  }

  if (status.status === "connected") {
    return (
      <div className="flex items-center justify-between gap-3 border border-gray-100 rounded-md px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-full bg-success-soft text-success flex items-center justify-center shrink-0">
            <CheckCircle2 className="h-4.5 w-4.5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800">Connected</p>
            {status.phone && <p className="text-xs text-gray-400">as +{status.phone}</p>}
          </div>
        </div>
        <Button size="sm" variant="destructive" onClick={disconnect} disabled={disconnecting}>
          {disconnecting ? "Disconnecting…" : "Disconnect"}
        </Button>
      </div>
    );
  }

  // status.status === "qr"
  return (
    <div className="flex flex-col items-center gap-3 py-4">
      {status.qr && (
        <img
          src={status.qr}
          alt="Scan with WhatsApp to link"
          className="h-52 w-52 rounded-md border border-gray-200 p-2"
        />
      )}
      <p className="text-xs text-gray-500 text-center max-w-xs">
        Open WhatsApp on the shop's phone → Settings → Linked Devices → Link a Device, then scan
        this code.
      </p>
    </div>
  );
}
