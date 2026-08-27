import { createFileRoute } from "@tanstack/react-router";
import { ReturnForm } from "@/components/ReturnForm";

export const Route = createFileRoute("/purchase-return/new")({
  component: () => <ReturnForm mode="purchase-return" />,
});
