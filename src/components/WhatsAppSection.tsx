/**
 * The WhatsApp card on the Settings page.
 *
 * Now a thin wrapper: the status, the QR and the wording all come from the
 * shared panel, which is the same one behind the header dot. It used to run
 * its own poll loop and its own copy of "waiting means…", which is how the
 * Settings page and the rest of the app could disagree about whether WhatsApp
 * was working.
 */
import { WhatsAppLinkPanel } from "@/components/WhatsAppLink";

export function WhatsAppSection() {
  return <WhatsAppLinkPanel />;
}
