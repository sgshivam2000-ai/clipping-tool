import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { StoreProvider } from "@/lib/store";
import { AppLayout } from "@/components/AppLayout";
import Dashboard from "@/pages/Dashboard";
import CreateClips from "@/pages/CreateClips";
import MyProjects from "@/pages/MyProjects";
import ClipEditor from "@/pages/ClipEditor";
import CaptionStudio from "@/pages/CaptionStudio";
import ExportHistory from "@/pages/ExportHistory";
import Settings from "@/pages/Settings";

export default function App() {
  return (
    <StoreProvider>
      <HashRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="create" element={<CreateClips />} />
            <Route path="projects" element={<MyProjects />} />
            <Route path="editor" element={<ClipEditor />} />
            <Route path="captions" element={<CaptionStudio />} />
            <Route path="exports" element={<ExportHistory />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </StoreProvider>
  );
}
