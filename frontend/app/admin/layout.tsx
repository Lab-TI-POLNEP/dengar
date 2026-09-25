"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { adminRequest, getCsrfToken } from "@/lib/admin-api";
import {
  LayoutGridIcon,
  TestTubeIcon,
  MusicIcon,
  BarChartIcon,
  ArchiveIcon,
  CogIcon,
  HeadphonesIcon,
  CheckCircleIcon,
  LogoutIcon,
  DengarIcon,
} from "@/components/Icons";
import "./admin.css";

const sections = [
  {
    title: "Overview",
    items: [{ label: "Dashboard", href: "/admin", icon: LayoutGridIcon }],
  },
  {
    title: "Studies",
    items: [
      { label: "Tests", href: "/admin/tests", icon: TestTubeIcon },
      { label: "Results", href: "/admin/results", icon: BarChartIcon },
    ],
  },
  {
    title: "Configuration",
    items: [
      { label: "Audio Library", href: "/admin/audio", icon: MusicIcon },
      { label: "Engines", href: "/admin/master-data/engines", icon: HeadphonesIcon },
      { label: "MOS Scales", href: "/admin/master-data/mos-scales", icon: CheckCircleIcon },
      { label: "Demographic", href: "/admin/master-data/demographic-fields", icon: CogIcon },
      { label: "Text Templates", href: "/admin/master-data/text-templates", icon: ArchiveIcon },
    ],
  },
  {
    title: "System",
    items: [
      { label: "Backup", href: "/admin/backup", icon: ArchiveIcon },
      { label: "Settings", href: "/admin/settings", icon: CogIcon },
    ],
  },
] as const;

function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    const csrf = await getCsrfToken();
    const response = await adminRequest("/admin/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
    });
    if (response.ok) {
      router.push("/admin/signin");
    }
  }

  return (
    <aside className="admin-sidebar">
      <Link href="/admin" className="admin-brand">
        <DengarIcon className="admin-brand__icon" />
        <span className="admin-brand__text">
          Dengar <span>Control</span>
        </span>
      </Link>
      {sections.map((section) => (
        <div key={section.title} className="admin-section">
          <p className="admin-section-title">{section.title}</p>
          <nav aria-label={section.title}>
            {section.items.map(({ label, href, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={pathname === href ? "is-active" : ""}
              >
                <Icon />
                {label}
              </Link>
            ))}
          </nav>
        </div>
      ))}
      <button onClick={signOut} className="admin-signout" type="button">
        <LogoutIcon />
        Sign out
      </button>
    </aside>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isSignIn = pathname === "/admin/signin";
  const [isCheckingAuth, setIsCheckingAuth] = useState(!isSignIn);

  useEffect(() => {
    if (isSignIn) {
      setIsCheckingAuth(false);
      return;
    }

    let isMounted = true;
    void adminRequest("/admin/dashboard")
      .then((response) => {
        if (!isMounted) return;
        if (response.status === 401) {
          router.push("/admin/signin");
          return;
        }
        if (response.ok) {
          setIsCheckingAuth(false);
          return;
        }
        router.push("/admin/signin");
      })
      .catch(() => {
        if (isMounted) {
          router.push("/admin/signin");
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isSignIn, router]);

  if (!isSignIn && isCheckingAuth) {
    return (
      <div className="admin-shell">
        <main className="admin-main">
          <p className="muted">Checking authentication…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="admin-shell">
      {!isSignIn && <Sidebar />}
      <main className="admin-main">{children}</main>
    </div>
  );
}
