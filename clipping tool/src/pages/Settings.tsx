import { useState } from "react";
import { BadgeCheck, CreditCard, Database, Mail, Server, ShieldCheck, Trash2, User, Zap } from "lucide-react";
import { formatBytes } from "@/lib/format";
import { getApiBase } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Avatar, Button, Card, Field, IconTile, Progress, SectionHeader, Segmented, Switch, inputCls } from "@/components/ui";

function ToggleRow({
  icon: Icon,
  title,
  desc,
  checked,
  onChange,
}: {
  icon: typeof User;
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-panel-2 px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <IconTile icon={Icon} className="h-8 w-8 rounded-lg" />
        <div>
          <p className="text-[13px] font-semibold text-fg">{title}</p>
          <p className="text-[11px] text-fg-3">{desc}</p>
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

export default function Settings() {
  const { toast, projects, mode } = useStore();
  const totalBytes = projects.reduce((s, p) => s + p.sizeBytes, 0);
  const [name, setName] = useState("Mike Keller");
  const [email, setEmail] = useState("mike@clipforge.ai");
  const [workspace, setWorkspace] = useState("Clipforge Studio");
  const [aspect, setAspect] = useState<"9:16" | "1:1" | "16:9">("9:16");
  const [captionStyle, setCaptionStyle] = useState("Bold");
  const [reframe, setReframe] = useState(true);
  const [autoCaptions, setAutoCaptions] = useState(true);
  const [autoExport, setAutoExport] = useState(false);
  const [nProcessing, setNProcessing] = useState(true);
  const [nDigest, setNDigest] = useState(false);
  const [nProduct, setNProduct] = useState(true);
  const [nMarketing, setNMarketing] = useState(false);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[24px] font-bold tracking-tight text-fg">Settings</h1>
        <p className="mt-1 text-[14px] text-fg-2">Workspace preferences, plan and notifications.</p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          {/* Profile */}
          <Card className="p-5 sm:p-6">
            <SectionHeader title="Profile" sub="This is how your workspace appears to teammates" />
            <div className="flex items-center gap-4">
              <Avatar name={name} size={56} className="border-accent/30" />
              <Button variant="secondary" size="sm" onClick={() => toast("Photo upload arrives in Phase 2", "info")}>
                Change photo
              </Button>
            </div>
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Full name">
                <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Email">
                <input value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} type="email" />
              </Field>
              <Field label="Workspace name">
                <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Role">
                <select className={`${inputCls} appearance-none`} defaultValue="Owner">
                  <option>Owner</option>
                  <option>Editor</option>
                  <option>Viewer</option>
                </select>
              </Field>
            </div>
            <div className="mt-5">
              <Button size="sm" onClick={() => toast("Profile saved")}>
                Save profile
              </Button>
            </div>
          </Card>

          {/* Preferences */}
          <Card className="p-5 sm:p-6">
            <SectionHeader title="Clip preferences" sub="Defaults applied to every new project" />
            <div className="space-y-5">
              <Field label="Default aspect ratio">
                <Segmented
                  options={[
                    { value: "9:16", label: "9:16 Vertical" },
                    { value: "1:1", label: "1:1 Square" },
                    { value: "16:9", label: "16:9 Landscape" },
                  ]}
                  value={aspect}
                  onChange={setAspect}
                />
              </Field>
              <Field label="Default caption style">
                <select
                  value={captionStyle}
                  onChange={(e) => setCaptionStyle(e.target.value)}
                  className={`${inputCls} max-w-xs appearance-none`}
                >
                  <option>Bold</option>
                  <option>Classic</option>
                  <option>Minimal</option>
                  <option>Karaoke</option>
                </select>
              </Field>
              <div className="space-y-2">
                <ToggleRow
                  icon={Zap}
                  title="Auto vertical reframe"
                  desc="Reframe every clip to 9:16 automatically"
                  checked={reframe}
                  onChange={setReframe}
                />
                <ToggleRow
                  icon={Zap}
                  title="Auto captions"
                  desc="Generate subtitles for every detected moment"
                  checked={autoCaptions}
                  onChange={setAutoCaptions}
                />
                <ToggleRow
                  icon={Zap}
                  title="Auto-export after processing"
                  desc="Render clips as soon as the pipeline finishes"
                  checked={autoExport}
                  onChange={setAutoExport}
                />
              </div>
              <Button size="sm" onClick={() => toast("Preferences saved")}>
                Save preferences
              </Button>
            </div>
          </Card>

          {/* Notifications */}
          <Card className="p-5 sm:p-6">
            <SectionHeader title="Notifications" sub="Choose what lands in your inbox" />
            <div className="space-y-2">
              <ToggleRow
                icon={Mail}
                title="Processing complete"
                desc="When your clips are ready to review"
                checked={nProcessing}
                onChange={setNProcessing}
              />
              <ToggleRow
                icon={Mail}
                title="Weekly digest"
                desc="Views and performance of your clips"
                checked={nDigest}
                onChange={setNDigest}
              />
              <ToggleRow
                icon={Mail}
                title="Product updates"
                desc="New CLIPFORGE AI features"
                checked={nProduct}
                onChange={setNProduct}
              />
              <ToggleRow
                icon={Mail}
                title="Marketing emails"
                desc="Offers and partner content"
                checked={nMarketing}
                onChange={setNMarketing}
              />
            </div>
            <div className="mt-5">
              <Button size="sm" onClick={() => toast("Notification settings saved")}>
                Save notifications
              </Button>
            </div>
          </Card>
        </div>

        <aside className="space-y-6">
          {/* Plan */}
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <IconTile icon={BadgeCheck} tone="accent" className="h-8 w-8 rounded-lg" />
                <span className="text-[14px] font-bold text-fg">Pro plan</span>
              </div>
              <span className="font-mono text-[15px] font-semibold text-fg">
                $29<span className="text-[11px] text-fg-3">/mo</span>
              </span>
            </div>
            <div className="mt-4 space-y-4">
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-[12px] font-semibold text-fg-2">Videos uploaded</span>
                  <span className="font-mono text-[11px] text-fg-3">{projects.length} projects</span>
                </div>
                <Progress value={Math.min(100, projects.length * 5)} className="mt-1.5" />
              </div>
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-[12px] font-semibold text-fg-2">Storage used</span>
                  <span className="font-mono text-[11px] text-fg-3">{formatBytes(totalBytes)}</span>
                </div>
                <Progress value={Math.min(100, (totalBytes / (2 * 1024 ** 3)) * 100)} className="mt-1.5" />
              </div>
              <div className="flex items-center justify-between rounded-xl border border-line bg-panel-2 px-3.5 py-3">
                <div className="flex items-center gap-2.5">
                  <IconTile
                    icon={mode === "server" ? Server : Database}
                    tone="accent"
                    className="h-8 w-8 rounded-lg"
                  />
                  <div>
                    <p className="text-[13px] font-semibold text-fg">
                      {mode === "server" ? "FastAPI server" : mode === "local" ? "Browser local storage" : "Detecting…"}
                    </p>
                    <p className="max-w-[190px] truncate text-[11px] text-fg-3">
                      {mode === "server" ? (getApiBase() ?? "") : "IndexedDB · videos stay on this device"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-5 flex gap-2">
              <Button className="flex-1" size="sm" onClick={() => toast("Upgrades unlock in Phase 2", "info")}>
                Upgrade to Studio
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={CreditCard}
                onClick={() => toast("Billing is disabled in this Phase 1 demo", "info")}
              >
                Manage
              </Button>
            </div>
          </Card>

          {/* Security note */}
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <IconTile icon={ShieldCheck} tone="accent" />
              <div>
                <p className="text-[13.5px] font-bold text-fg">Your data stays yours</p>
                <p className="mt-1 text-[12px] leading-relaxed text-fg-3">
                  Source videos are processed in an isolated environment and deleted after 30 days unless you keep them
                  in a project.
                </p>
              </div>
            </div>
          </Card>

          {/* Danger zone */}
          <Card className="border-red-500/20 p-5">
            <p className="text-[13.5px] font-bold text-red-400">Danger zone</p>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-3">
              Permanently delete this workspace, all projects and exports.
            </p>
            <Button
              variant="danger"
              size="sm"
              icon={Trash2}
              className="mt-4"
              onClick={() => toast("Not available in this demo", "info")}
            >
              Delete workspace
            </Button>
          </Card>
        </aside>
      </div>
    </div>
  );
}
