import { createFileRoute } from "@tanstack/react-router";
import { InvoiceForm } from "@/components/InvoiceForm";

export const Route = createFileRoute("/sales/new")({
  component: () => <InvoiceForm mode="sale" />,
});
