import { useEffect, useState, useSyncExternalStore } from "react";
import { TeamUserRepo, subscribeTeamRoster } from "@/repositories";
import { auth } from "@/lib/firebase";
import { createTeamUserServerFn, deleteTeamUserServerFn } from "@/lib/teamAdmin";
import type { ModuleKey, ModulePermission, TeamUser } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/Field";
import { toast } from "sonner";
import { Plus, UserCog, ShieldCheck, Trash2 } from "lucide-react";

const MODULES: { key: ModuleKey; label: string }[] = [
  { key: "masterData", label: "Master Data" },
  { key: "sales", label: "Sales" },
  { key: "purchaseExpenses", label: "Purchase & Expenses" },
  { key: "cashBank", label: "Cash & Bank" },
  { key: "reports", label: "Reports" },
];

const emptyPermissions = (): Record<ModuleKey, ModulePermission> =>
  Object.fromEntries(
    MODULES.map((m) => [m.key, { view: false, edit: false, delete: false }]),
  ) as Record<ModuleKey, ModulePermission>;

export function TeamSection() {
  const roster = useSyncExternalStore(subscribeTeamRoster, TeamUserRepo.roster, () => []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TeamUser | null>(null);

  useEffect(() => {
    TeamUserRepo.hydrateRoster().catch(() => {
      // Non-owner or transient error — the roster section just stays empty;
      // this component only ever renders for the owner in the first place.
    });
    return () => TeamUserRepo.stopRoster();
  }, []);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const toggleActive = async (u: TeamUser) => {
    try {
      await TeamUserRepo.update(u.id, { active: !u.active });
      toast.success(u.active ? `${u.name} deactivated` : `${u.name} reactivated`);
    } catch {
      toast.error("Could not update — check your internet connection");
    }
  };

  const deleteMember = async (u: TeamUser) => {
    if (
      !confirm(
        `Permanently delete ${u.name}'s login? This can't be undone — to just remove access ` +
          `temporarily, use Deactivate instead.`,
      )
    )
      return;
    setDeletingId(u.id);
    try {
      const callerIdToken = await auth.currentUser?.getIdToken();
      if (!callerIdToken) throw new Error("Not signed in");
      await deleteTeamUserServerFn({ data: { callerIdToken, targetUid: u.id } });
      toast.success(`${u.name} deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete team member");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        {roster.length === 0 && (
          <p className="text-xs text-gray-400">
            No team members yet — you're the only one with access right now.
          </p>
        )}
        {roster.map((u) => (
          <div
            key={u.id}
            className="w-full flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border border-gray-100 rounded-md px-3.5 py-2.5"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-800 truncate flex items-center gap-1.5">
                {u.name}
                {u.isOwner && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-primary bg-primary-soft px-1.5 py-0.5 rounded">
                    <ShieldCheck className="h-3 w-3" /> Owner
                  </span>
                )}
                {!u.isOwner && !u.active && (
                  <span className="text-[10px] font-semibold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                    Deactivated
                  </span>
                )}
              </p>
              <p className="text-xs text-gray-400 truncate">{u.email}</p>
            </div>
            {!u.isOwner && (
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(u)}
                  className="flex-1 sm:flex-none"
                >
                  <UserCog className="h-3.5 w-3.5" /> Permissions
                </Button>
                <Button
                  size="sm"
                  variant={u.active ? "destructive" : "outline"}
                  onClick={() => toggleActive(u)}
                  className="flex-1 sm:flex-none"
                >
                  {u.active ? "Deactivate" : "Reactivate"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive shrink-0"
                  disabled={deletingId === u.id}
                  onClick={() => deleteMember(u)}
                  title="Permanently delete this login"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <Button type="button" onClick={() => setDialogOpen(true)}>
        <Plus className="h-3.5 w-3.5" /> Add Team Member
      </Button>

      <AddTeamMemberDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <EditPermissionsDialog user={editing} onOpenChange={(v) => !v && setEditing(null)} />
    </div>
  );
}

function PermissionGrid({
  value,
  onChange,
}: {
  value: Record<ModuleKey, ModulePermission>;
  onChange: (v: Record<ModuleKey, ModulePermission>) => void;
}) {
  const set = (module: ModuleKey, level: keyof ModulePermission, v: boolean) =>
    onChange({ ...value, [module]: { ...value[module], [level]: v } });

  return (
    <div className="border rounded-md overflow-hidden">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-3 py-2 bg-gray-50 text-[11px] font-semibold text-gray-500 uppercase">
        <span>Module</span>
        <span className="w-10 text-center">View</span>
        <span className="w-10 text-center">Edit</span>
        <span className="w-10 text-center">Delete</span>
      </div>
      {MODULES.map((m) => (
        <div
          key={m.key}
          className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-3 py-2 border-t items-center text-sm"
        >
          <span>{m.label}</span>
          <span className="w-10 flex justify-center">
            <Checkbox
              checked={value[m.key].view}
              onCheckedChange={(v) => set(m.key, "view", !!v)}
            />
          </span>
          <span className="w-10 flex justify-center">
            <Checkbox
              checked={value[m.key].edit}
              onCheckedChange={(v) => set(m.key, "edit", !!v)}
              disabled={m.key === "reports"}
            />
          </span>
          <span className="w-10 flex justify-center">
            <Checkbox
              checked={value[m.key].delete}
              onCheckedChange={(v) => set(m.key, "delete", !!v)}
              disabled={m.key === "reports"}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

function AddTeamMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [permissions, setPermissions] =
    useState<Record<ModuleKey, ModulePermission>>(emptyPermissions());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setEmail("");
      setPassword("");
      setPermissions(emptyPermissions());
    }
  }, [open]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!name.trim() || !email.trim() || password.length < 6) {
      toast.error("Name, email, and a password of at least 6 characters are required");
      return;
    }
    setSaving(true);
    try {
      const callerIdToken = await auth.currentUser?.getIdToken();
      if (!callerIdToken) throw new Error("Not signed in");
      await createTeamUserServerFn({
        data: { callerIdToken, email: email.trim(), password, name: name.trim(), permissions },
      });
      toast.success(`${name} can now sign in`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create team member");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Team Member</DialogTitle>
          <DialogDescription>
            They'll sign in with this email and password — share it with them directly.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-3">
          <Field label="Name *" value={name} onChange={(e) => setName(e.target.value)} />
          <Field
            label="Email *"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            label="Temporary Password *"
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <PermissionGrid value={permissions} onChange={setPermissions} />
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditPermissionsDialog({
  user,
  onOpenChange,
}: {
  user: TeamUser | null;
  onOpenChange: (v: boolean) => void;
}) {
  const [permissions, setPermissions] =
    useState<Record<ModuleKey, ModulePermission>>(emptyPermissions());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      const merged = emptyPermissions();
      for (const m of MODULES) {
        if (user.permissions[m.key])
          merged[m.key] = { ...merged[m.key], ...user.permissions[m.key] };
      }
      setPermissions(merged);
    }
  }, [user]);

  if (!user) return null;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await TeamUserRepo.update(user.id, { permissions });
      toast.success(`${user.name}'s permissions updated`);
      onOpenChange(false);
    } catch {
      toast.error("Could not update — check your internet connection");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{user.name}'s Permissions</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <PermissionGrid value={permissions} onChange={setPermissions} />
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
