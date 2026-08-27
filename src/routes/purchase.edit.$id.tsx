import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PurchaseRepo } from "@/repositories";
import { InvoiceForm } from "@/components/InvoiceForm";
import { useRepoData } from "@/hooks/useRepoData";
import type { Invoice } from "@/types";
import { AlertCircle } from "lucide-react";

export const Route = createFileRoute("/purchase/edit/$id")({ component: EditPurchasePage });

function EditPurchasePage() {
  const _repoV = useRepoData();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [inv, setInv] = useState<Invoice | null | undefined>(undefined);

  useEffect(() => {
    setInv(PurchaseRepo.get(id) ?? null);
  }, [id, _repoV]);

  if (inv === undefined) return null;
  if (inv === null) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-gray-400">
        <AlertCircle className="h-12 w-12 text-gray-200" />
        <p className="font-medium">Bill not found</p>
        <button
          onClick={() => navigate({ to: "/purchase" })}
          className="text-sm text-primary hover:underline"
        >
          ← Back to Purchase
        </button>
      </div>
    );
  }
  return <InvoiceForm key={inv.id} mode="purchase" existing={inv} />;
}
