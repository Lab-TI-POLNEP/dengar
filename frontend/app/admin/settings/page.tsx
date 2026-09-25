"use client";

import { useEffect, useState } from "react";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";

type AdminSettings = {
  admin_username: string;
  username_locked: boolean;
  default_page_size: number;
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pageSizeInput, setPageSizeInput] = useState("20");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  async function loadSettings() {
    setLoading(true);
    setError("");
    try {
      const response = await adminRequest("/admin/api/settings");
      if (response.status === 401) {
        window.location.href = "/admin/signin";
        return;
      }
      if (!response.ok) {
        setError("Could not load the current admin settings.");
        return;
      }
      const payload = (await response.json()) as AdminSettings;
      setSettings(payload);
      setPageSizeInput(String(payload.default_page_size));
    } catch {
      setError("Unable to load settings right now.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");

    try {
      const csrf = await getCsrfToken();
      const nextSettings: Record<string, string | number> = {
        default_page_size: Number(pageSizeInput),
      };

      if (password.trim() || confirmPassword.trim()) {
        nextSettings.new_password = password;
        nextSettings.confirm_password = confirmPassword;
      }

      const response = await adminRequest("/admin/api/settings", {
        method: "PUT",
        headers: {
          "X-CSRF-Token": csrf,
        },
        body: JSON.stringify(nextSettings),
      });

      if (response.status === 401) {
        window.location.href = "/admin/signin";
        return;
      }

      const payload = (await response.json().catch(() => ({}))) as { error?: string; default_page_size?: number };
      if (!response.ok) {
        setError(payload.error ?? "Unable to save the admin settings.");
        return;
      }

      if (typeof payload.default_page_size === "number") {
        setPageSizeInput(String(payload.default_page_size));
      }
      setSettings((current) =>
        current
          ? { ...current, default_page_size: payload.default_page_size ?? current.default_page_size }
          : current
      );
      setPassword("");
      setConfirmPassword("");
      setNotice("Settings saved successfully.");
    } catch {
      setError("Your settings could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="admin-page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap", marginBottom: "1.5rem" }}>
        <div>
          <p className="eyebrow">System</p>
          <h1 style={{ margin: 0 }}>Settings</h1>
          <p className="admin-lede" style={{ marginTop: "0.35rem" }}>Global defaults and admin profile controls.</p>
        </div>
      </div>

      {error && (
        <p role="alert" className="form-error" style={{ marginBottom: "1rem" }}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="success-banner" style={{ marginBottom: "1rem" }}>
          {notice}
        </p>
      )}

      {loading ? (
        <div className="admin-empty">
          <strong>Loading settings…</strong>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="admin-form" style={{ display: "grid", gap: "1.25rem", maxWidth: "46rem" }}>
          <div className="admin-card" style={{ padding: "1.25rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
              <div>
                <p className="eyebrow" style={{ margin: 0, letterSpacing: ".12em" }}>Pagination</p>
                <h2 style={{ margin: "0.3rem 0 0" }}>Default list size</h2>
              </div>
              <span className="status-badge status-badge--neutral">Global</span>
            </div>

            <label style={{ display: "grid", gap: "0.5rem" }}>
              <span>Records per page</span>
              <input
                className="input"
                type="number"
                min={5}
                max={100}
                value={pageSizeInput}
                onChange={(event) => setPageSizeInput(event.target.value)}
              />
            </label>
          </div>

          <div className="admin-card" style={{ padding: "1.25rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
              <div>
                <p className="eyebrow" style={{ margin: 0, letterSpacing: ".12em" }}>Admin account</p>
                <h2 style={{ margin: "0.3rem 0 0" }}>Password</h2>
              </div>
            </div>

            <div style={{ display: "grid", gap: "1rem" }}>
              <label style={{ display: "grid", gap: "0.45rem" }}>
                <span>Username</span>
                <input className="input" value={settings?.admin_username ?? "admin"} disabled readOnly aria-readonly="true" />
              </label>
              <p className="muted" style={{ margin: 0 }}>
                The administrator username is fixed to {settings?.admin_username ?? "admin"}. Only the password can be updated here.
              </p>

              <label style={{ display: "grid", gap: "0.45rem" }}>
                <span>New password</span>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Leave blank to keep the current password"
                  autoComplete="new-password"
                />
              </label>

              <label style={{ display: "grid", gap: "0.45rem" }}>
                <span>Confirm password</span>
                <input
                  className="input"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Repeat the new password"
                  autoComplete="new-password"
                />
              </label>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" className="admin-button admin-button--primary" disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
