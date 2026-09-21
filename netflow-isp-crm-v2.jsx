import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  AreaChart, Area, LineChart, Line, PieChart, Pie, Cell,
  ResponsiveContainer, XAxis, YAxis, Tooltip
} from "recharts";
import {
  Search, Bell, Plus, MoreHorizontal, Wifi, Activity,
  AlertTriangle, DollarSign, Users, MapPin, Server, Router,
  Radio, Clock, ArrowUpRight, ArrowDownRight, Truck, Zap,
  User, ChevronRight, BarChart2, WifiOff as WifiOffIcon,
  CheckCircle2, Shield, RefreshCw, ArrowUpDown, Rows3, AlignJustify,
  Info, XCircle, X, WifiOff
} from "lucide-react";

// =====================================================================
// MOCK DATA — en producción esto vendría de React Query / SWR contra
// la API del CRM, con websockets/SSE para los campos "en vivo"
// (estado de nodos, alertas, tickets nuevos).
// =====================================================================

const uptimeData = [
  { h: "00h", v: 99.2 }, { h: "04h", v: 99.6 }, { h: "08h", v: 98.1 },
  { h: "12h", v: 97.4 }, { h: "16h", v: 99.0 }, { h: "20h", v: 99.5 }, { h: "24h", v: 99.7 },
];

const spark = (base, vol) => Array.from({ length: 12 }, (_, i) => ({
  x: i, v: Math.max(0, base + Math.sin(i / 1.6) * vol + (Math.random() - 0.5) * vol * 0.6),
}));

const kpis = [
  { id: "subscribers", icon: Users, label: "Abonados activos", value: "1,042", delta: "+18", positive: true, accent: "#0284C7", bgAccent: "bg-sky-50 text-sky-700 border-sky-200", data: spark(1020, 15), roles: ["admin", "cobrador", "finanzas"], hint: "vs. ayer" },
  { id: "uptime", icon: Activity, label: "Uptime de red (24h)", value: "99.1%", delta: "-0.4%", positive: false, accent: "#2563EB", bgAccent: "bg-blue-50 text-blue-700 border-blue-200", data: spark(98.5, 1.2), roles: ["admin", "tecnico"], hint: "vs. objetivo SLA 99.5%" },
  { id: "tickets", icon: AlertTriangle, label: "Tickets abiertos", value: "14", delta: "+3", positive: false, accent: "#D97706", bgAccent: "bg-amber-50 text-amber-700 border-amber-200", data: spark(11, 4), roles: ["admin", "tecnico"], hint: "vs. hace 1 hora" },
  { id: "billing", icon: DollarSign, label: "Cartera vencida", value: "$2,340", delta: "-$180", positive: true, accent: "#DC2626", bgAccent: "bg-rose-50 text-rose-700 border-rose-200", data: spark(2400, 200), roles: ["admin", "cobrador", "finanzas"], hint: "vs. ayer" },
  { id: "throughput", icon: Zap, label: "Throughput pico", value: "840 Mbps", delta: "+62 Mbps", positive: true, accent: "#7C3AED", bgAccent: "bg-violet-50 text-violet-700 border-violet-200", data: spark(780, 80), roles: ["admin", "tecnico"], hint: "últimas 24h" },
  { id: "tech_visits", icon: Truck, label: "Visitas técnicas hoy", value: "7", delta: "3 en curso", positive: true, accent: "#059669", bgAccent: "bg-emerald-50 text-emerald-700 border-emerald-200", data: spark(6, 2), roles: ["admin", "tecnico", "cobrador"], hint: "planificadas hoy" },
];

const billingBreakdown = [
  { name: "Al día", value: 862, color: "#10B981" },
  { name: "Por vencer", value: 139, color: "#F59E0B" },
  { name: "Vencido", value: 41, color: "#EF4444" },
];

const nodes = [
  { id: "OLT-01", zone: "La Maná Centro", clients: 412, health: "ok", pons: [
      { id: "PON 1", clients: 118, dbm: -19.2, health: "ok" },
      { id: "PON 2", clients: 96, dbm: -21.4, health: "ok" },
      { id: "PON 3", clients: 104, dbm: -24.8, health: "warning" },
      { id: "PON 4", clients: 94, dbm: -20.1, health: "ok" },
    ]},
  { id: "OLT-02", zone: "Valencia", clients: 288, health: "critical", pons: [
      { id: "PON 1", clients: 71, dbm: -18.9, health: "ok" },
      { id: "PON 2", clients: 0, dbm: null, health: "critical" },
      { id: "PON 3", clients: 217, dbm: -19.5, health: "ok" },
    ]},
  { id: "OLT-03", zone: "El Triunfo / Guasaganda", clients: 342, health: "ok", pons: [
      { id: "PON 1", clients: 168, dbm: -20.3, health: "ok" },
      { id: "PON 2", clients: 174, dbm: -22.0, health: "ok" },
    ]},
];

const healthColor = { ok: "#10B981", warning: "#F59E0B", critical: "#EF4444" };
const healthLabel = { ok: "Operativo", warning: "Degradado", critical: "Crítico" };

const alerts = [
  { label: "Nodo Valencia caído", detail: "OLT-02 · PON 2 · 34 clientes afectados", time: "hace 6 min", severity: "critical" },
  { label: "Señal degradada", detail: "OLT-01 · PON 3 · -24.8 dBm promedio", time: "hace 22 min", severity: "warning" },
  { label: "Reclamo de lentitud", detail: "Carlos Andrade · Plan 20 Mbps", time: "hace 41 min", severity: "info" },
  { label: "Corte por mora ejecutado", detail: "18 cuentas · script MikroTik", time: "hace 1 h", severity: "info" },
];

const severityMeta = {
  critical: { color: "#DC2626", bg: "bg-rose-100 text-rose-800 border-rose-300", label: "CRÍTICO", Icon: XCircle },
  warning:  { color: "#D97706", bg: "bg-amber-100 text-amber-800 border-amber-300", label: "AVISO", Icon: AlertTriangle },
  info:     { color: "#2563EB", bg: "bg-blue-100 text-blue-800 border-blue-300", label: "INFO", Icon: Info },
  resolved: { color: "#059669", bg: "bg-emerald-100 text-emerald-800 border-emerald-300", label: "RESUELTO", Icon: CheckCircle2 },
};

const tickets = {
  "Nuevo": [
    { title: "Sin internet desde anoche", client: "Paola Vera", zone: "Guasaganda", priority: "alta" },
    { title: "Consulta de plan", client: "Andrea Ruiz", zone: "La Maná Centro", priority: "baja" },
  ],
  "En progreso": [
    { title: "Lentitud recurrente", client: "Carlos Andrade", zone: "Valencia", priority: "media", tech: "JS" },
    { title: "Reubicación de equipo", client: "Jorge Salinas", zone: "El Triunfo", priority: "media", tech: "MP" },
  ],
  "Resuelto hoy": [
    { title: "Cambio de ONU dañada", client: "Lucía Peñaherrera", zone: "La Maná Centro", priority: "alta", tech: "JS" },
  ],
};

const priorityColor = {
  alta: "bg-rose-50 text-rose-700 border-rose-200",
  media: "bg-amber-50 text-amber-700 border-amber-200",
  baja: "bg-emerald-50 text-emerald-700 border-emerald-200"
};

const techs = [
  { name: "Jhon Salazar", init: "JS", job: "OLT-02 · falla de fibra troncal", eta: "12 min", status: "en ruta" },
  { name: "Mishell Proaño", init: "MP", job: "Reubicación equipo · El Triunfo", eta: "35 min", status: "en sitio" },
  { name: "Byron Chicaiza", init: "BC", job: "Disponible", eta: "—", status: "libre" },
];

const emitters = [
  { name: "AP Omni Cornejo", equipment: "Rocket AC Lite", ip: "10.0.0.10", status: "offline" },
  { name: "PTP Valencia", equipment: "Mimosa B11", ip: "10.0.0.14", status: "online" },
  { name: "Sector El Triunfo", equipment: "Ubiquiti LTU-Pro", ip: "10.0.0.21", status: "online" },
  { name: "Backbone OLT-01", equipment: "Mimosa A5c", ip: "10.0.0.2", status: "online" },
  { name: "PTP Guasaganda", equipment: "Ubiquiti AF-11", ip: "10.0.0.33", status: "degraded" },
];

const emitterStatusMeta = {
  online:   { bg: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "EN LÍNEA" },
  offline:  { bg: "bg-rose-50 text-rose-700 border-rose-200", label: "DESCONECTADO" },
  degraded: { bg: "bg-amber-50 text-amber-700 border-amber-200", label: "DEGRADADA" },
};

const recentPayments = [
  { client: "Alfred Rodríguez", amount: 20.00, operator: "cobrador_01", time: "hace 10 min", method: "Efectivo / Campo" },
  { client: "Héctor Vega", amount: 17.00, operator: "admin", time: "hace 45 min", method: "DeUna QR" },
  { client: "María Solís", amount: 95.00, operator: "sistema", time: "hace 2 horas", method: "Transferencia Pichincha" },
  { client: "Luis Andrade", amount: 15.00, operator: "cobrador_02", time: "hace 3 horas", method: "Efectivo / Campo" },
];

// =====================================================================
// ATOMS
// =====================================================================

function StatusDot({ color, animate = true, size = 10 }) {
  return (
    <span className="relative flex shrink-0" style={{ height: size, width: size }}>
      {animate && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: color }} />
      )}
      <span className="relative inline-flex rounded-full h-full w-full" style={{ backgroundColor: color }} />
    </span>
  );
}

// Badge que combina color + ícono + texto — nunca depende solo del color,
// para que siga siendo legible con daltonismo o en pantallas de campo mal calibradas.
function SeverityBadge({ severity }) {
  const meta = severityMeta[severity];
  const Icon = meta.Icon;
  return (
    <span className={`inline-flex items-center gap-1 nf-t9 font-mono font-bold px-2 py-0.5 rounded uppercase ${meta.bg}`}>
      <Icon size={10} /> {meta.label}
    </span>
  );
}

function EmptyState({ icon: Icon = CheckCircle2, title, subtitle }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-4">
      <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center mb-3">
        <Icon size={18} className="text-slate-400" />
      </div>
      <div className="text-xs font-semibold text-slate-600">{title}</div>
      {subtitle && <div className="nf-t11 text-slate-400 mt-1">{subtitle}</div>}
    </div>
  );
}

function KPICardSkeleton() {
  return (
    <div className="nf-card p-5 animate-pulse">
      <div className="flex items-center justify-between mb-3">
        <div className="h-10 w-10 rounded-xl bg-slate-100" />
        <div className="h-4 w-12 rounded-full bg-slate-100" />
      </div>
      <div className="h-6 w-20 bg-slate-100 rounded mb-2" />
      <div className="h-3 w-28 bg-slate-100 rounded mb-3" />
      <div className="h-8 w-full bg-slate-50 rounded" />
    </div>
  );
}

function SectionSkeleton({ rows = 3 }) {
  return (
    <div className="animate-pulse flex flex-col gap-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-14 bg-slate-100 rounded-xl" />
      ))}
    </div>
  );
}

// Contador animado: toma "1,042", "99.1%", "$2,340", "840 Mbps" y cuenta
// desde 0 respetando prefijo, sufijo y decimales. Números tabulares para
// que el ancho no "baile" mientras cuenta o cuando llegan datos en vivo.
function useCountUp(valueStr) {
  const [display, setDisplay] = useState(valueStr);
  useEffect(() => {
    const m = String(valueStr).match(/^([^\d]*)([\d,]+(?:\.\d+)?)(.*)$/);
    if (!m) { setDisplay(valueStr); return; }
    const [, prefix, numStr, suffix] = m;
    const target = parseFloat(numStr.replace(/,/g, ""));
    const decimals = (numStr.split(".")[1] || "").length;
    const duration = 900;
    const start = performance.now();
    let raf;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = eased * target;
      setDisplay(prefix + v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [valueStr]);
  return display;
}

const BRAND = "#0369A1";
const CARD_SHADOW = "nf-card";

// Un solo color de marca para lo neutral; el color de estado solo aparece
// en la tendencia (verde = bien, rojo = atención).
function KPICard({ icon: Icon, label, value, delta, positive, data, hint }) {
  const shown = useCountUp(value);
  return (
    <div
      className={`relative p-5 overflow-hidden ${CARD_SHADOW} nf-card-hover focus-within:ring-2 focus-within:ring-sky-400`}
      tabIndex={0}
      role="group"
      aria-label={`${label}: ${value}, variación ${delta} ${hint || ""}`}
    >
      <div className="nf-stripe" />
      <div className="nf-kpi-icon flex items-center justify-center bg-sky-50 text-sky-700 mb-3">
        <Icon size={18} strokeWidth={2.2} aria-hidden="true" />
      </div>
      <div className="nf-kpi-value font-extrabold text-slate-900 nf-sora tabular-nums">{shown}</div>
      <div className="nf-t115 font-medium text-slate-500 mt-1.5">{label}</div>
      <div className="flex items-end justify-between mt-2.5 gap-2">
        <div className={`flex items-center gap-1 nf-t105 font-mono font-bold whitespace-nowrap ${positive ? "text-emerald-600" : "text-rose-600"}`}>
          {positive ? <ArrowUpRight size={12} aria-hidden="true" /> : <ArrowDownRight size={12} aria-hidden="true" />}
          {delta} <span className="font-medium text-slate-400">{hint}</span>
        </div>
      </div>
      <div className="h-6 mt-2 -mx-1 opacity-60">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <Line type="monotone" dataKey="v" stroke={BRAND} strokeWidth={1.75} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function SectionCard({ title, subtitle, right, children, className = "" }) {
  return (
    <div className={`overflow-hidden ${CARD_SHADOW} ${className}`}>
      <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <span className="h-5 w-1 rounded-full bg-gradient-to-b from-sky-700 to-sky-400" aria-hidden="true" />
          <div>
            <h3 className="nf-sora font-bold text-sm text-slate-900 tracking-tight">{title}</h3>
            {subtitle && <p className="nf-t115 text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
        </div>
        {right}
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

// Botón de ícono reutilizable, siempre con aria-label + foco visible.
function IconButton({ icon: Icon, label, onClick, active = false, size = 16 }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`h-8 w-8 rounded-lg flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
        active ? "bg-sky-100 text-sky-700" : "text-slate-400 hover:text-slate-700 hover:bg-slate-100"
      }`}
    >
      <Icon size={size} />
    </button>
  );
}

function SortHeader({ label, sortKey, currentSort, onSort }) {
  const isActive = currentSort.key === sortKey;
  return (
    <th className="pb-3 font-bold">
      <button
        onClick={() => onSort(sortKey)}
        className="flex items-center gap-1 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded"
      >
        {label}
        <ArrowUpDown size={11} className={isActive ? "text-sky-600" : "text-slate-300"} />
      </button>
    </th>
  );
}

function timeAgo(seconds) {
  if (seconds < 5) return "justo ahora";
  if (seconds < 60) return `hace ${seconds}s`;
  return `hace ${Math.floor(seconds / 60)} min`;
}

// =====================================================================
// MAIN DASHBOARD
// =====================================================================

export default function App() {
  const [activeNav, setActiveNav] = useState("Panel");
  const [currentRole, setCurrentRole] = useState("admin");
  const [isLoading, setIsLoading] = useState(true);
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [density, setDensity] = useState("comfortable"); // "comfortable" | "compact"
  const [emitterSort, setEmitterSort] = useState({ key: null, dir: "asc" });
  const searchInputRef = useRef(null);

  // Simula la carga inicial contra la API — en producción sería el estado
  // "loading" de React Query mientras resuelve el primer fetch.
  useEffect(() => {
    const t = setTimeout(() => setIsLoading(false), 700);
    return () => clearTimeout(t);
  }, []);

  // Reloj de "actualizado hace Xs" + polling simulado. En producción esto
  // se reemplaza por un websocket/SSE que empuja cambios de estado de red
  // en tiempo real en vez de refrescar por intervalo.
  useEffect(() => {
    const tick = setInterval(() => {
      setSecondsSinceUpdate((s) => {
        if (autoRefresh && s >= 30) return 0;
        return s + 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [autoRefresh]);

  const handleManualRefresh = useCallback(() => {
    setIsRefreshing(true);
    setTimeout(() => {
      setSecondsSinceUpdate(0);
      setIsRefreshing(false);
    }, 500);
  }, []);

  // Atajo de teclado "/" para enfocar el buscador — estándar en herramientas
  // operativas (Linear, GitHub, Slack) que se usan con el teclado todo el día.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nav = [
    { name: "Panel", icon: Activity },
    { name: "Abonados", icon: Users },
    { name: "Red", icon: Router },
    { name: "Tickets", icon: AlertTriangle },
    { name: "Facturación", icon: DollarSign },
  ];

  const filteredKpis = useMemo(
    () => kpis.filter(k => k.roles.includes(currentRole)),
    [currentRole]
  );

  const filteredEmitters = useMemo(() => {
    let list = emitters;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(e =>
        e.name.toLowerCase().includes(q) ||
        e.equipment.toLowerCase().includes(q) ||
        e.ip.includes(q)
      );
    }
    if (emitterSort.key) {
      list = [...list].sort((a, b) => {
        const av = a[emitterSort.key], bv = b[emitterSort.key];
        const cmp = String(av).localeCompare(String(bv));
        return emitterSort.dir === "asc" ? cmp : -cmp;
      });
    }
    return list;
  }, [searchQuery, emitterSort]);

  const handleSort = (key) => {
    setEmitterSort((prev) => ({
      key,
      dir: prev.key === key && prev.dir === "asc" ? "desc" : "asc",
    }));
  };

  const rowPad = density === "compact" ? "py-1.5" : "py-3.5";
  const totalPayments = recentPayments.reduce((sum, p) => sum + p.amount, 0);

  return (
    <div className="w-full min-h-screen nf-root text-slate-800 flex" style={{ fontFamily: "Inter, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        *:focus-visible { outline: none; }
        .nf-root { background: #E4E9F0; }
        .nf-sora { font-family: 'Sora', sans-serif; }
        .nf-card {
          background: #FFFFFF;
          border-radius: 18px;
          border: 1px solid rgba(15, 23, 42, 0.06);
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 10px 28px -12px rgba(15, 23, 42, 0.22);
        }
        .nf-card-hover { transition: transform .2s ease, box-shadow .2s ease; cursor: default; }
        .nf-card-hover:hover {
          transform: translateY(-4px);
          box-shadow: 0 8px 16px rgba(15, 23, 42, 0.08), 0 24px 44px -16px rgba(3, 105, 161, 0.35);
        }
        .nf-soft { box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12), 0 1px 2px rgba(15, 23, 42, 0.06); }
        .nf-lift { transition: transform .18s ease, box-shadow .18s ease; }
        .nf-lift:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 14px rgba(15, 23, 42, 0.10), 0 14px 28px -14px rgba(3, 105, 161, 0.35);
        }
        .nf-stripe { position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, #0369A1, #38BDF8); }
        .nf-kpi-icon { width: 38px; height: 38px; border-radius: 11px; }
        .nf-kpi-value { font-size: 26px; line-height: 1; letter-spacing: -0.02em; }
        .nf-nav-active { box-shadow: inset 3px 0 0 #0369A1; }
        .nf-btn-brand { box-shadow: 0 6px 16px -6px rgba(3, 105, 161, 0.6); }
        .nf-scroll { max-height: 380px; }
        .nf-t9 { font-size: 9px; } .nf-t10 { font-size: 10px; } .nf-t105 { font-size: 10.5px; }
        .nf-t11 { font-size: 11px; } .nf-t115 { font-size: 11.5px; }
      `}</style>

      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r border-slate-200/60 flex flex-col py-6 px-4 bg-white">
        <div className="flex items-center gap-3 px-2 mb-6">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-sky-500 to-blue-600 flex items-center justify-center text-white shadow-md shadow-sky-500/20">
            <Radio size={22} strokeWidth={2.5} />
          </div>
          <div>
            <div className="nf-sora font-bold text-base tracking-tight text-slate-900">NETFLOW ISP</div>
            <div className="nf-t10 font-mono text-sky-600 uppercase font-bold tracking-wider">Gestión CRM</div>
          </div>
        </div>

        <div className="mb-6 bg-slate-50 p-2.5 rounded-xl">
          <label htmlFor="role-select" className="nf-t10 uppercase font-mono font-bold text-slate-400 mb-1.5 flex items-center gap-1">
            <Shield size={12} className="text-sky-600" /> Vista por Perfil:
          </label>
          <select
            id="role-select"
            value={currentRole}
            onChange={(e) => setCurrentRole(e.target.value)}
            className="w-full bg-white border border-slate-300 rounded-lg text-xs font-semibold py-1.5 px-2 text-slate-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100 font-mono shadow-sm"
          >
            <option value="admin">Administrador General</option>
            <option value="tecnico">Técnico de Campo / NOC</option>
            <option value="cobrador">Cobrador / Puerta a Puerta</option>
            <option value="finanzas">Finanzas y Contabilidad</option>
          </select>
        </div>

        <nav className="flex flex-col gap-1.5" aria-label="Navegación principal">
          {nav.map((item) => (
            <button
              key={item.name}
              onClick={() => setActiveNav(item.name)}
              aria-current={activeNav === item.name ? "page" : undefined}
              className={`text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all duration-150 flex items-center gap-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                activeNav === item.name
                  ? "bg-sky-50 text-sky-800 nf-nav-active"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              <item.icon size={17} className={activeNav === item.name ? "text-sky-600" : "text-slate-400"} aria-hidden="true" />
              {item.name}
            </button>
          ))}
        </nav>

        <div className="mt-8 pt-6 border-t border-slate-100">
          <div className="nf-t10 uppercase tracking-widest text-slate-400 px-2 mb-3 font-mono font-bold">Estado Troncal</div>
          <div className="flex flex-col gap-2">
            {nodes.map(n => (
              <div key={n.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50">
                <div className="flex items-center gap-2.5">
                  <StatusDot color={healthColor[n.health]} animate={n.health !== "ok"} />
                  <span className="text-xs font-mono font-bold text-slate-700">{n.id}</span>
                </div>
                <span
                  className="nf-t11 font-mono font-medium text-slate-500"
                  title={healthLabel[n.health]}
                >
                  {n.clients} clientes
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-auto pt-6 border-t border-slate-100 flex items-center gap-3 px-2">
          <div className="h-9 w-9 rounded-full bg-sky-100 border border-sky-300 flex items-center justify-center text-xs nf-sora font-bold text-sky-800">
            JC
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-slate-900 truncate">Jose C.</div>
            <div className="nf-t10 font-mono font-semibold text-emerald-600 flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Activo
            </div>
          </div>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b border-slate-200/80 flex items-center justify-between px-8 shrink-0 bg-white/80 backdrop-blur-md sticky top-0 z-10">
          <div>
            <h1 className="nf-sora font-bold text-lg text-slate-900 flex items-center gap-2">
              Panel Operativo CRM
              <span className="text-xs font-mono font-bold text-sky-700 bg-sky-50 px-2.5 py-0.5 rounded-full border border-sky-200 uppercase">{currentRole}</span>
            </h1>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>Lunes 24 de agosto · La Maná, Ecuador</span>
              <span className="text-slate-300">·</span>
              <span className="flex items-center gap-1" role="status" aria-live="polite">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                </span>
                Actualizado {timeAgo(secondsSinceUpdate)}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative flex items-center gap-2.5 bg-white nf-soft rounded-xl px-3.5 py-2 w-72 focus-within:border-sky-500 focus-within:ring-2 focus-within:ring-sky-100 transition-colors">
              <Search size={16} className="text-slate-400" aria-hidden="true" />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar equipo, IP..."
                aria-label="Buscar equipo, IP o nombre"
                className="bg-transparent text-xs text-slate-800 outline-none placeholder:text-slate-400 w-full font-mono"
              />
              {searchQuery ? (
                <button onClick={() => setSearchQuery("")} aria-label="Limpiar búsqueda" className="text-slate-400 hover:text-slate-600">
                  <X size={14} />
                </button>
              ) : (
                <kbd className="hidden sm:inline nf-t10 font-mono text-slate-400 bg-white border border-slate-200 rounded px-1.5 py-0.5">/</kbd>
              )}
            </div>

            <IconButton
              icon={RefreshCw}
              label="Actualizar datos ahora"
              onClick={handleManualRefresh}
              size={16}
            />
            <div className={isRefreshing ? "hidden" : ""} />

            <button className="h-9 w-9 rounded-xl bg-white nf-soft flex items-center justify-center relative hover:bg-slate-50 text-slate-600 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400" aria-label="Notificaciones, 1 sin leer">
              <Bell size={16} />
              <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-rose-500" />
            </button>
            <button className="h-9 px-4 rounded-xl bg-gradient-to-r from-sky-700 to-sky-500 hover:from-sky-800 hover:to-sky-600 text-white nf-btn-brand text-xs font-bold nf-sora flex items-center gap-2 shadow-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2">
              <Plus size={16} strokeWidth={2.5} /> Nuevo Abonado
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-auto p-8 flex flex-col gap-6">
          {/* KPIs */}
          <div className="grid grid-cols-4 gap-4">
            {isLoading
              ? Array.from({ length: 4 }).map((_, i) => <KPICardSkeleton key={i} />)
              : filteredKpis.map((k) => <KPICard key={`${currentRole}-${k.id}`} {...k} />)}
          </div>

          {(currentRole === "admin" || currentRole === "tecnico") && (
            <div className="grid grid-cols-3 gap-6">
              <SectionCard
                title="Topología de Red GPON"
                subtitle="Nodos OLT → Puertos PON (Optimizado para visibilidad en campo)"
                right={<IconButton icon={MoreHorizontal} label="Más opciones de topología" />}
                className="col-span-2"
              >
                {isLoading ? <SectionSkeleton rows={3} /> : (
                  <div className="flex flex-col gap-4">
                    {nodes.map((n) => (
                      <div key={n.id} className="rounded-xl p-4 bg-slate-50/80">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className="h-9 w-9 rounded-xl bg-white flex items-center justify-center nf-soft">
                              <Server size={17} style={{ color: healthColor[n.health] }} aria-hidden="true" />
                            </div>
                            <div>
                              <div className="text-sm font-bold text-slate-900 font-mono">{n.id}</div>
                              <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                                <MapPin size={12} className="text-slate-400" /> {n.zone}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-sky-800 font-mono bg-sky-50 px-2.5 py-1 rounded-md font-bold tabular-nums">{n.clients} Abonados</span>
                            <span className="sr-only">{healthLabel[n.health]}</span>
                            <StatusDot color={healthColor[n.health]} animate={n.health !== "ok"} />
                          </div>
                        </div>
                        <div className="grid grid-cols-4 gap-2.5 pl-3 border-l-2 border-sky-100 ml-4">
                          {n.pons.map((p) => (
                            <div key={p.id} className="bg-white rounded-lg p-2.5 nf-soft">
                              <div className="flex items-center justify-between">
                                <span className="text-xs text-slate-700 font-mono font-bold">{p.id}</span>
                                <StatusDot color={healthColor[p.health]} animate={p.health !== "ok"} size={6} />
                              </div>
                              <div className="text-xs text-slate-900 mt-1 font-mono font-bold">{p.clients} ONUs</div>
                              <div className="nf-t11 text-slate-500 font-mono font-medium mt-0.5">{p.dbm ? `${p.dbm} dBm` : "Sin Señal"}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>

              <SectionCard title="Alertas Técnicas" subtitle="Prioridad en tiempo real">
                {alerts.length === 0 ? (
                  <EmptyState icon={CheckCircle2} title="Sin alertas activas" subtitle="Todo operando con normalidad" />
                ) : (
                  <div className="flex flex-col gap-3 nf-scroll overflow-auto pr-1">
                    {alerts.map((a, i) => (
                      <div key={i} className="flex gap-3 p-3 rounded-xl bg-slate-50/80">
                        <div className="mt-1"><StatusDot color={severityMeta[a.severity].color} animate={a.severity === "critical" || a.severity === "warning"} /></div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-bold text-slate-900">{a.label}</div>
                          <div className="nf-t11 text-slate-600 font-mono mt-0.5">{a.detail}</div>
                          <div className="flex items-center justify-between mt-2">
                            <SeverityBadge severity={a.severity} />
                            <span className="nf-t10 text-slate-400 font-mono">{a.time}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </div>
          )}

          {(currentRole === "admin" || currentRole === "tecnico") && (
            <div className="grid grid-cols-3 gap-6">
              <SectionCard title="Tickets de Soporte Campo" subtitle="Incidencias asignadas" className="col-span-2">
                <div className="grid grid-cols-3 gap-4">
                  {Object.entries(tickets).map(([col, items]) => (
                    <div key={col} className="bg-slate-50/80 rounded-xl p-3">
                      <div className="flex items-center justify-between mb-3 px-1">
                        <span className="text-xs font-bold text-slate-700 uppercase font-mono">{col}</span>
                        <span className="nf-t10 text-slate-600 font-mono font-bold bg-white shadow-sm rounded-full px-2 py-0.5">{items.length}</span>
                      </div>
                      {items.length === 0 ? (
                        <div className="nf-t11 text-slate-400 text-center py-6">Sin tickets</div>
                      ) : (
                        <div className="flex flex-col gap-2.5">
                          {items.map((t, i) => (
                            <button
                              key={i}
                              className="text-left w-full bg-white rounded-xl p-3 nf-soft nf-lift transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <span className="text-xs font-bold text-slate-800 leading-snug">{t.title}</span>
                                <span className={`nf-t9 font-mono font-bold px-1.5 py-0.5 rounded uppercase shrink-0 ${priorityColor[t.priority]}`}>
                                  {t.priority}
                                </span>
                              </div>
                              <div className="nf-t11 text-slate-500 mt-2 flex items-center gap-1 font-mono">
                                <User size={12} className="text-slate-400" /> {t.client} · {t.zone}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </SectionCard>

              <SectionCard title="Personal en Campo" subtitle="Despliegue operativo">
                <div className="flex flex-col gap-3">
                  {techs.map((t) => (
                    <div key={t.init} className="flex items-center gap-3 rounded-xl p-3 bg-slate-50/80">
                      <div className="h-9 w-9 rounded-full bg-sky-50 flex items-center justify-center text-xs nf-sora font-bold text-sky-800 shrink-0">
                        {t.init}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-bold text-slate-900">{t.name}</div>
                        <div className="nf-t11 text-slate-500 font-mono truncate">{t.job}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="nf-t10 font-mono font-bold uppercase" style={{ color: t.status === "libre" ? "#059669" : "#D97706" }}>{t.status}</div>
                        <div className="nf-t10 text-slate-400 font-mono flex items-center gap-1 justify-end mt-0.5">
                          <Clock size={11} /> {t.eta}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </div>
          )}

          {(currentRole === "admin" || currentRole === "cobrador" || currentRole === "finanzas") && (
            <div className="grid grid-cols-3 gap-6">
              <SectionCard
                title="Últimos Cobros Registrados"
                subtitle={`${recentPayments.length} pagos · $${totalPayments.toFixed(2)} recaudado`}
                className="col-span-2"
                right={
                  <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5">
                    <IconButton icon={AlignJustify} label="Vista cómoda" onClick={() => setDensity("comfortable")} active={density === "comfortable"} size={14} />
                    <IconButton icon={Rows3} label="Vista compacta" onClick={() => setDensity("compact")} active={density === "compact"} size={14} />
                  </div>
                }
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="text-slate-400 nf-t11 font-mono uppercase border-b border-slate-200">
                        <th className="pb-3 font-bold">Cliente</th>
                        <th className="pb-3 font-bold">Monto</th>
                        <th className="pb-3 font-bold">Método</th>
                        <th className="pb-3 font-bold">Operador / Cobrador</th>
                        <th className="pb-3 font-bold text-right">Tiempo</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {recentPayments.map((p, i) => (
                        <tr key={i} className="text-xs hover:bg-slate-50 transition-colors">
                          <td className={`${rowPad} font-bold text-slate-900 uppercase`}>{p.client}</td>
                          <td className={`${rowPad} font-mono font-bold text-emerald-600 tabular-nums`}>${p.amount.toFixed(2)}</td>
                          <td className={`${rowPad} text-slate-600 font-mono`}>{p.method}</td>
                          <td className={`${rowPad} text-slate-600 font-mono`}>{p.operator}</td>
                          <td className={`${rowPad} text-slate-400 font-mono text-right`}>{p.time}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionCard>

              <SectionCard title="Estado Recaudación Mes" subtitle="Distribución de cartera">
                <div className="flex items-center gap-4">
                  <ResponsiveContainer width={120} height={120}>
                    <PieChart>
                      <Pie data={billingBreakdown} dataKey="value" innerRadius={36} outerRadius={54} paddingAngle={4} stroke="none" isAnimationActive={false}>
                        {billingBreakdown.map((b, i) => <Cell key={i} fill={b.color} />)}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex flex-col gap-2.5 flex-1">
                    {billingBreakdown.map((b) => (
                      <div key={b.name} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: b.color }} />
                          <span className="text-slate-700 font-semibold">{b.name}</span>
                        </div>
                        <span className="text-slate-900 font-mono font-bold">{b.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </SectionCard>
            </div>
          )}

          {(currentRole === "admin" || currentRole === "tecnico") && (
            <SectionCard
              title="Monitoreo de Enlaces Radio / PTP"
              subtitle={`${filteredEmitters.length} de ${emitters.length} equipos${searchQuery ? ` · filtrado por "${searchQuery}"` : ""}`}
            >
              {filteredEmitters.length === 0 ? (
                <EmptyState icon={WifiOff} title="Sin resultados" subtitle={`Ningún equipo coincide con "${searchQuery}"`} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="text-slate-400 nf-t11 font-mono uppercase border-b border-slate-200">
                        <SortHeader label="Equipo / Nombre" sortKey="name" currentSort={emitterSort} onSort={handleSort} />
                        <SortHeader label="Modelo" sortKey="equipment" currentSort={emitterSort} onSort={handleSort} />
                        <SortHeader label="Dirección IP" sortKey="ip" currentSort={emitterSort} onSort={handleSort} />
                        <SortHeader label="Estado" sortKey="status" currentSort={emitterSort} onSort={handleSort} />
                        <th className="pb-3 font-bold text-right">Diagnóstico</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredEmitters.map((e, i) => {
                        const meta = emitterStatusMeta[e.status];
                        return (
                          <tr key={i} className="text-xs hover:bg-slate-50 transition-colors">
                            <td className={`${rowPad} font-bold text-slate-900`}>{e.name}</td>
                            <td className={`${rowPad} text-slate-600 font-mono`}>{e.equipment}</td>
                            <td className={`${rowPad} font-mono font-bold text-sky-700`}>{e.ip}</td>
                            <td className={rowPad}>
                              <span className={`nf-t10 font-mono font-bold px-2.5 py-1 rounded-md ${meta.bg}`}>
                                {meta.label}
                              </span>
                            </td>
                            <td className={`${rowPad} text-right`}>
                              <div className="flex items-center justify-end gap-3 text-slate-400">
                                {e.status === "offline"
                                  ? <WifiOffIcon size={16} className="text-rose-600" aria-label="Sin conexión" />
                                  : <Wifi size={16} className="text-emerald-600" aria-label="Conectado" />}
                                <IconButton icon={BarChart2} label={`Ver historial de señal de ${e.name}`} size={16} />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          )}
        </div>
      </main>
    </div>
  );
}
