import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export function AppLayout() {
  const location = useLocation();
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    window.scrollTo(0, 0);
    setMobileNav(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-base text-fg">
      {/* Desktop sidebar */}
      <Sidebar className="fixed inset-y-0 left-0 z-40 hidden md:flex" />

      {/* Mobile drawer */}
      {mobileNav && (
        <>
          <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setMobileNav(false)} />
          <Sidebar
            className="animate-slide-in fixed inset-y-0 left-0 z-50 md:hidden"
            onNavigate={() => setMobileNav(false)}
          />
        </>
      )}

      <div className="md:pl-[248px]">
        <TopBar onMenu={() => setMobileNav(true)} />
        <main key={location.pathname} className="animate-page mx-auto w-full max-w-[1400px] p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
