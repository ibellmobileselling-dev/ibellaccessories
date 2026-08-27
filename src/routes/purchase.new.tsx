import { createFileRoute } from "@tanstack/react-router";
import { InvoiceForm } from "@/components/InvoiceForm";

export const Route = createFileRoute("/purchase/new")({
  component: () => <InvoiceForm mode="purchase" />,
});
