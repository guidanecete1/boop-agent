import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api.js";

type Project = {
  _id: string;
  slug: string;
  displayName: string;
  type: "ios-native" | "expo" | "nextjs-vercel" | "growth-work";
  path?: string;
  permission: "read-only" | "read-write" | "full";
  metadata?: string;
  notes?: string;
  archived?: boolean;
};

const TYPES = [
  "ios-native",
  "expo",
  "nextjs-vercel",
  "growth-work",
] as const;

const PERMS = ["read-only", "read-write", "full"] as const;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : "…" + s.slice(-(n - 1));
}

export function ProjectsPanel({ isDark }: { isDark: boolean }) {
  const projects = useQuery(api.projects.list, {}) ?? [];
  const upsert = useMutation(api.projects.upsert);
  const archive = useMutation(api.projects.archive);
  const [editing, setEditing] = useState<Project | "new" | null>(null);

  const visible = projects as Project[];

  const mutedText = isDark ? "text-slate-500" : "text-slate-400";
  const borderColor = isDark ? "border-slate-800" : "border-slate-200";
  const tableBg = isDark ? "bg-slate-900/40" : "bg-white";
  const theadBg = isDark ? "bg-slate-800/60" : "bg-slate-50";
  const theadText = isDark ? "text-slate-400" : "text-slate-500";
  const rowHover = isDark ? "hover:bg-slate-800/40" : "hover:bg-slate-50";
  const codeBg = isDark
    ? "bg-slate-800 text-slate-300"
    : "bg-slate-100 text-slate-700";
  const btnBase = isDark
    ? "text-xs px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300"
    : "text-xs px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600";
  const btnDanger = isDark
    ? "text-xs px-2 py-0.5 rounded bg-rose-900/40 hover:bg-rose-900/70 text-rose-400 ml-1"
    : "text-xs px-2 py-0.5 rounded bg-rose-50 hover:bg-rose-100 text-rose-500 ml-1";
  const btnPrimary = isDark
    ? "text-xs px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium"
    : "text-xs px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium";

  return (
    <div className="flex flex-col h-full -m-5">
      {/* Header */}
      <div
        className={`shrink-0 border-b px-5 py-3 flex items-center justify-between ${borderColor}`}
      >
        <h2
          className={`text-xs font-semibold uppercase tracking-wider ${mutedText}`}
        >
          Projects
        </h2>
        <button className={btnPrimary} onClick={() => setEditing("new")}>
          + New project
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto p-5">
        <div className={`rounded-lg border overflow-hidden ${borderColor} ${tableBg}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className={`text-xs uppercase tracking-wide ${theadBg} ${theadText}`}>
                <th className="text-left px-4 py-2.5 font-medium">Slug</th>
                <th className="text-left px-4 py-2.5 font-medium">
                  Display name
                </th>
                <th className="text-left px-4 py-2.5 font-medium">Type</th>
                <th className="text-left px-4 py-2.5 font-medium">
                  Permission
                </th>
                <th className="text-left px-4 py-2.5 font-medium">Path</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr
                  key={p._id}
                  className={`border-t ${borderColor} ${rowHover} transition-colors`}
                >
                  <td className="px-4 py-2.5">
                    <code
                      className={`text-xs px-1.5 py-0.5 rounded font-mono ${codeBg}`}
                    >
                      {p.slug}
                    </code>
                  </td>
                  <td className="px-4 py-2.5">{p.displayName}</td>
                  <td className={`px-4 py-2.5 ${mutedText} text-xs`}>
                    {p.type}
                  </td>
                  <td className="px-4 py-2.5">
                    <PermBadge perm={p.permission} isDark={isDark} />
                  </td>
                  <td
                    className={`px-4 py-2.5 font-mono text-xs ${mutedText}`}
                    title={p.path ?? ""}
                  >
                    {p.path ? (
                      truncate(p.path, 50)
                    ) : (
                      <em className="not-italic opacity-40">(none)</em>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <button className={btnBase} onClick={() => setEditing(p)}>
                      Edit
                    </button>
                    <button
                      className={btnDanger}
                      onClick={() => {
                        if (confirm(`Archive "${p.slug}"?`)) {
                          archive({ slug: p.slug }).catch((e) =>
                            alert(String(e)),
                          );
                        }
                      }}
                    >
                      Archive
                    </button>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className={`px-4 py-8 text-center text-sm ${mutedText}`}
                  >
                    No projects. Click "+ New project" to add one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <ProjectEditModal
          initial={editing === "new" ? null : editing}
          isDark={isDark}
          onClose={() => setEditing(null)}
          onSave={async (vals) => {
            await upsert(vals);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function PermBadge({
  perm,
  isDark,
}: {
  perm: Project["permission"];
  isDark: boolean;
}) {
  const colors: Record<Project["permission"], string> = {
    "read-only": isDark
      ? "bg-slate-700 text-slate-300"
      : "bg-slate-100 text-slate-600",
    "read-write": isDark
      ? "bg-sky-900/50 text-sky-300"
      : "bg-sky-50 text-sky-700",
    full: isDark
      ? "bg-emerald-900/50 text-emerald-300"
      : "bg-emerald-50 text-emerald-700",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[perm]}`}
    >
      {perm}
    </span>
  );
}

type SaveVals = {
  slug: string;
  displayName: string;
  type: Project["type"];
  path?: string;
  permission: Project["permission"];
  metadata?: string;
  notes?: string;
};

function ProjectEditModal({
  initial,
  isDark,
  onClose,
  onSave,
}: {
  initial: Project | null;
  isDark: boolean;
  onClose: () => void;
  onSave: (vals: SaveVals) => Promise<void>;
}) {
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [type, setType] = useState<Project["type"]>(
    initial?.type ?? "ios-native",
  );
  const [path, setPath] = useState(initial?.path ?? "");
  const [permission, setPermission] = useState<Project["permission"]>(
    initial?.permission ?? "full",
  );
  const [metadata, setMetadata] = useState(initial?.metadata ?? "{}");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const backdropBg = "bg-black/60 backdrop-blur-sm";
  const modalBg = isDark ? "bg-slate-900 border-slate-700" : "bg-white border-slate-200";
  const inputCls = isDark
    ? "w-full mt-1 px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-sky-500"
    : "w-full mt-1 px-3 py-1.5 rounded bg-white border border-slate-300 text-sm text-slate-800 focus:outline-none focus:border-sky-500";
  const labelCls = isDark
    ? "block text-xs font-medium text-slate-400 mt-3"
    : "block text-xs font-medium text-slate-500 mt-3";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!slug.trim()) {
      setError("Slug is required.");
      return;
    }
    if (metadata.trim()) {
      try {
        JSON.parse(metadata);
      } catch (err) {
        setError(`metadata must be valid JSON: ${String(err)}`);
        return;
      }
    }
    setSaving(true);
    try {
      await onSave({
        slug: slug.trim(),
        displayName: displayName.trim() || slug.trim(),
        type,
        path: path.trim() || undefined,
        permission,
        metadata: metadata.trim() || undefined,
        notes: notes.trim() || undefined,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${backdropBg}`}
      onClick={onClose}
    >
      <form
        className={`relative w-full max-w-lg rounded-xl border shadow-2xl p-6 ${modalBg} max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3 className="text-base font-semibold mb-1">
          {initial ? `Edit "${initial.slug}"` : "New project"}
        </h3>

        <label className={labelCls}>
          Slug
          <input
            className={inputCls}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={!!initial}
            required
            placeholder="my-project"
          />
        </label>

        <label className={labelCls}>
          Display name
          <input
            className={inputCls}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="My Project"
          />
        </label>

        <label className={labelCls}>
          Type
          <select
            className={inputCls}
            value={type}
            onChange={(e) => setType(e.target.value as Project["type"])}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className={labelCls}>
          Path
          <input
            className={inputCls}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/projects/my-project"
          />
        </label>

        <div className="mt-3">
          <span className={labelCls.replace(" mt-3", "")}>Permission</span>
          <div className="flex gap-3 mt-1.5">
            {PERMS.map((p) => (
              <label
                key={p}
                className={`flex items-center gap-1.5 text-sm cursor-pointer ${
                  isDark ? "text-slate-300" : "text-slate-700"
                }`}
              >
                <input
                  type="radio"
                  checked={permission === p}
                  onChange={() => setPermission(p)}
                  className="accent-sky-500"
                />
                {p}
              </label>
            ))}
          </div>
        </div>

        <label className={labelCls}>
          Metadata (JSON)
          <textarea
            className={inputCls}
            rows={4}
            value={metadata}
            onChange={(e) => setMetadata(e.target.value)}
            spellCheck={false}
          />
        </label>

        <label className={labelCls}>
          Notes
          <textarea
            className={inputCls}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        {error && (
          <div className="mt-3 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className={
              isDark
                ? "px-4 py-1.5 rounded text-sm bg-slate-700 hover:bg-slate-600 text-slate-300"
                : "px-4 py-1.5 rounded text-sm bg-slate-100 hover:bg-slate-200 text-slate-600"
            }
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-1.5 rounded text-sm bg-sky-600 hover:bg-sky-500 text-white font-medium disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
