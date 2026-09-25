"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";
import Input from "@/components/Input";

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = new FormData(event.currentTarget);
    const csrf = await getCsrfToken();
    const response = await adminRequest("/admin/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password"), csrf_token: csrf }) });
    if (!response.ok) { setError("Sign-in failed. Check your credentials."); return; }
    router.push("/admin");
  }
  return <section className="admin-auth"><p className="eyebrow">Administrator access</p><h1>Sign in</h1><form onSubmit={submit} className="admin-form"><label>Username<Input name="username" required autoComplete="username" /></label><label>Password<Input name="password" type="password" required autoComplete="current-password" /></label>{error && <p role="alert" className="form-error">{error}</p>}<button type="submit" className="admin-button admin-button--primary">Sign in</button></form></section>;
}