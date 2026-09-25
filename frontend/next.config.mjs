const backendOrigin =
  process.env.BACKEND_ORIGIN ?? process.env.NEXT_PUBLIC_BACKEND_ORIGIN ?? "http://localhost:4000";

export default {
  output: "standalone",
  async rewrites() {
    return [
      { source: "/admin/api/:path*", destination: `${backendOrigin}/admin/api/:path*` },
      { source: "/admin/csrf-token", destination: `${backendOrigin}/admin/csrf-token` },
      { source: "/admin/login", destination: `${backendOrigin}/admin/login` },
      { source: "/admin/logout", destination: `${backendOrigin}/admin/logout` },
      { source: "/admin/dashboard", destination: `${backendOrigin}/admin/dashboard` },
      { source: "/api/sessions/:path*", destination: `${backendOrigin}/api/sessions/:path*` },
      { source: "/api/tests/:path*", destination: `${backendOrigin}/api/tests/:path*` },
      { source: "/api/media/:path*", destination: `${backendOrigin}/api/media/:path*` },
    ];
  },
};
