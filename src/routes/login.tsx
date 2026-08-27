import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { APP_NAME, APP_VERSION } from "@/lib/version";
import { toast } from "sonner";
import {
  Sparkles,
  Mail,
  Lock,
  Eye,
  EyeOff,
  Loader2,
  AlertCircle,
  Receipt,
  Package,
  BarChart3,
  CloudUpload,
} from "lucide-react";

export const Route = createFileRoute("/login")({ component: LoginPage });

function friendlyAuthError(code: string): string {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect email or password. Please try again.";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a few minutes and try again.";
    case "auth/network-request-failed":
      return "No internet connection. Check your network and try again.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact your administrator.";
    default:
      return "Sign in failed. Please try again.";
  }
}

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email.trim()) {
      setError("Please enter your email address.");
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      setError("Please enter your password.");
      return;
    }
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      // Redirect is handled by the auth gate in __root
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      setError(friendlyAuthError(code));
      setLoading(false);
    }
  };

  const forgotPassword = async () => {
    if (!email.trim()) {
      setError("Enter your email above first, then click Forgot password.");
      emailRef.current?.focus();
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email.trim());
      toast.success(`Password reset link sent to ${email.trim()}`);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      setError(friendlyAuthError(code));
    }
  };

  return (
    <div className="min-h-screen w-full flex bg-background">
      {/* Brand panel */}
      <div className="hidden lg:flex w-[45%] bg-gradient-brand text-brand-foreground flex-col justify-between p-10 xl:p-14">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center ring-1 ring-white/25">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <p className="font-bold tracking-tight text-[20px]">{APP_NAME}</p>
            <p className="text-[11px] uppercase tracking-[0.2em] opacity-80">Billing · Inventory</p>
          </div>
        </div>

        <div className="max-w-md">
          <h1 className="text-[32px] xl:text-[38px] font-extrabold leading-tight tracking-tight">
            Run your whole business from one screen
          </h1>
          <p className="mt-3 text-white/80 text-[15px] leading-relaxed">
            GST billing, stock, payments, and profit reports — fast, keyboard-first, and now backed
            up safely in the cloud.
          </p>
          <div className="mt-8 space-y-4">
            <Feature
              icon={Receipt}
              title="GST invoices in seconds"
              desc="Auto party & item creation right from the bill"
            />
            <Feature
              icon={Package}
              title="Live stock tracking"
              desc="Every sale, purchase and return updates inventory"
            />
            <Feature
              icon={BarChart3}
              title="Profit you can trust"
              desc="P&L, ledgers and GST reports always in sync"
            />
            <Feature
              icon={CloudUpload}
              title="Cloud backup & sync"
              desc="Your data is safe even if this computer fails"
            />
          </div>
        </div>

        <div />
      </div>

      {/* Login form */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-[400px]">
          {/* Mobile brand header */}
          <div className="lg:hidden flex items-center gap-2.5 mb-8 justify-center">
            <div className="h-10 w-10 rounded-lg bg-gradient-brand text-brand-foreground flex items-center justify-center">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <p className="font-bold tracking-tight text-[18px]">{APP_NAME}</p>
              <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Billing · Inventory
              </p>
            </div>
          </div>

          <h2 className="text-[24px] font-bold tracking-tight">Welcome back</h2>
          <p className="text-sm text-muted-foreground mt-1 mb-7">
            Sign in to access your billing workspace
          </p>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[13px] text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="text-[13px] font-medium text-foreground">Email address</span>
              <div className="mt-1.5 relative">
                <Mail className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={emailRef}
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@business.com"
                  className="w-full h-11 pl-10 pr-3 border rounded-lg bg-background text-[14px] focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none transition"
                />
              </div>
            </label>

            <label className="block">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-foreground">Password</span>
                <button
                  type="button"
                  onClick={forgotPassword}
                  className="text-[12px] text-primary hover:underline font-medium"
                >
                  Forgot password?
                </button>
              </div>
              <div className="mt-1.5 relative">
                <Lock className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type={showPass ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full h-11 pl-10 pr-11 border rounded-lg bg-background text-[14px] focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition"
                  title={showPass ? "Hide password" : "Show password"}
                >
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 rounded-lg bg-primary text-primary-foreground font-semibold text-[14px] hover:opacity-90 transition disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Signing in…
                </>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          <p className="mt-8 text-center text-[12px] text-muted-foreground">
            Access is by invitation only. Contact your administrator for an account.
          </p>
          <p className="mt-2 text-center text-[10px] text-muted-foreground/60 tabular-nums">
            Version {APP_VERSION}
          </p>
        </div>
      </div>
    </div>
  );
}

function Feature({
  icon: Icon,
  title,
  desc,
}: {
  icon: typeof Receipt;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex items-start gap-3.5">
      <div className="h-9 w-9 rounded-lg bg-white/12 ring-1 ring-white/20 flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="font-semibold text-[14px]">{title}</p>
        <p className="text-[12.5px] text-white/70">{desc}</p>
      </div>
    </div>
  );
}
