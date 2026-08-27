import { createFileRoute } from "@tanstack/react-router";
import { ReturnForm } from "@/components/ReturnForm";

export const Route = createFileRoute("/sale-return/new")({
  component: () => <ReturnForm mode="sale-return" />,
});
