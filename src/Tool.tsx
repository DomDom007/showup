// Showup: learns from past appointments which bookings tend to be missed, and suggests reminders and safe overbooking.
import { useMemo, useState } from "react";
import { csvObjects, num } from "./lib/csv";
import { waLink } from "./lib/share";
import { uid, useStored } from "./lib/store";
import { addDays, todayISO } from "./lib/time";
import { ImportBox, Section, Stat, Stats } from "./ui/kit";

const T = "showup";
type Hist = { patient: string; date: string; hour: number; lead: number; newPt: boolean; showed: boolean };
type Appt = { id: string; patient: string; phone: string; date: string; time: string; lead: number; newPt: boolean; reminded?: boolean };
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function sampleHist(): Hist[] {
  let s = 11; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const pts = Array.from({ length: 60 }, (_, i) => `P${100 + i}`), flaky = new Set(pts.filter((_, i) => i % 7 === 0));
  return Array.from({ length: 600 }, () => {
    const p = pts[Math.floor(r() * pts.length)], lead = Math.floor(r() * 40), hour = 8 + Math.floor(r() * 10), date = addDays(todayISO(), -Math.floor(r() * 180)), wd = new Date(date).getDay();
    const risk = 0.06 + (lead > 21 ? 0.12 : lead > 7 ? 0.05 : 0) + (hour >= 17 ? 0.06 : 0) + (wd === 1 ? 0.05 : 0) + (flaky.has(p) ? 0.3 : 0);
    return { patient: p, date, hour, lead, newPt: r() < 0.2, showed: r() > risk };
  });
}

/** Simple, explainable model: base rate adjusted by how each factor's no-show rate differs from the base. */
function model(h: Hist[]) {
  const base = h.length ? h.filter(x => !x.showed).length / h.length : 0.1;
  const rate = (f: (x: Hist) => boolean) => { const g = h.filter(f); return g.length >= 10 ? g.filter(x => !x.showed).length / g.length : base; };
  const leadB = (l: number) => (l > 21 ? 3 : l > 7 ? 2 : l > 1 ? 1 : 0);
  const byLead = [0, 1, 2, 3].map(b => rate(x => leadB(x.lead) === b));
  const byDow = DOW.map((_, d) => rate(x => new Date(x.date).getDay() === d));
  const byHour = (hr: number) => rate(x => Math.abs(x.hour - hr) <= 1);
  const newR = rate(x => x.newPt);
  const patient = (p: string) => { const g = h.filter(x => x.patient === p); return { n: g.length, missed: g.filter(x => !x.showed).length }; };
  const predict = (a: { patient: string; date: string; time: string; lead: number; newPt: boolean }) => {
    let odds = base / (1 - base);
    const adj = (r: number) => { const o = r / (1 - r) / (base / (1 - base)); odds *= Math.pow(o, 0.8); };
    adj(byLead[leadB(a.lead)]); adj(byDow[new Date(a.date).getDay()]); adj(byHour(parseInt(a.time)));
    if (a.newPt) adj(newR);
    const pt = patient(a.patient);
    if (pt.n >= 2) { const pr = (pt.missed + base * 2) / (pt.n + 2); adj(pr); }
    return { p: Math.min(0.95, odds / (1 + odds)), pt };
  };
  return { base, byLead, byDow, predict };
}

export default function Showup() {
  const [hist, setHist] = useStored<Hist[]>(T, "hist", sampleHist());
  const [clinic, setClinic] = useStored(T, "clinic", "Cabinet Dentaire Lac 2");
  const [appts, setAppts] = useStored<Appt[]>(T, "appts", [
    { id: "a1", patient: "P100", phone: "", date: addDays(todayISO(), 1), time: "09:00", lead: 30, newPt: false }, { id: "a2", patient: "P101", phone: "", date: addDays(todayISO(), 1), time: "10:00", lead: 3, newPt: false },
    { id: "a3", patient: "P107", phone: "", date: addDays(todayISO(), 1), time: "11:00", lead: 25, newPt: false }, { id: "a4", patient: "New: Rania", phone: "", date: addDays(todayISO(), 1), time: "17:30", lead: 14, newPt: true },
    { id: "a5", patient: "P114", phone: "", date: addDays(todayISO(), 1), time: "15:00", lead: 2, newPt: false }, { id: "a6", patient: "P121", phone: "", date: addDays(todayISO(), 1), time: "16:00", lead: 35, newPt: false },
  ]);
  const [d, setD] = useState({ patient: "", phone: "", date: addDays(todayISO(), 1), time: "10:00", newPt: false });
  const m = useMemo(() => model(hist), [hist]);
  const rows = appts.map(a => ({ a, ...m.predict(a) })).sort((x, y) => (x.a.date + x.a.time).localeCompare(y.a.date + y.a.time));
  const expected = rows.reduce((s, r) => s + r.p, 0);
  const days = [...new Set(rows.map(r => r.a.date))];
  const band = (p: number) => (p >= 0.3 ? ["High", "bad"] : p >= 0.15 ? ["Medium", "warn"] : ["Low", "good"]);

  return (
    <div className="stack">
      <Section title={clinic}>
        <Stats><Stat value={`${Math.round(m.base * 100)}%`} label="Usual no-show rate" /><Stat value={hist.length} label="Past appointments learned from" /><Stat value={expected.toFixed(1)} label="Expected no-shows coming up" tone="warn" /><Stat value={rows.filter(r => r.p >= 0.3).length} label="High-risk bookings" tone="bad" /></Stats>
        <div className="row" style={{ gap: 20, marginTop: 16 }}>
          <div><p className="eyebrow">By how far ahead it was booked</p><div className="su-bars">{["Same or next day", "2 to 7 days", "8 to 21 days", "22+ days"].map((l, i) => <div key={l}><span style={{ height: `${m.byLead[i] * 250}%` }} /><em>{l}</em><b>{Math.round(m.byLead[i] * 100)}%</b></div>)}</div></div>
          <div><p className="eyebrow">By weekday</p><div className="su-bars">{DOW.map((l, i) => i > 0 && i < 7 && <div key={l}><span style={{ height: `${m.byDow[i] * 250}%` }} /><em>{l}</em><b>{Math.round(m.byDow[i] * 100)}%</b></div>)}</div></div>
        </div>
      </Section>
      {days.map(day => { const list = rows.filter(r => r.a.date === day); const exp = list.reduce((s, r) => s + r.p, 0); return (
        <Section key={day} title={new Date(day).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} aside={<span className={"pill " + (exp >= 1 ? "warn" : "")}>{exp >= 1 ? `Expect about ${Math.round(exp)} gap${Math.round(exp) > 1 ? "s" : ""}. Safe to overbook ${Math.floor(exp)} slot${Math.floor(exp) === 1 ? "" : "s"} late in the day.` : `Expected no-shows: ${exp.toFixed(1)}`}</span>}>
          {list.map(r => { const b = band(r.p); return (
            <div key={r.a.id} className="su-row">
              <span className="num" style={{ width: 52, fontFamily: "var(--mono)" }}>{r.a.time}</span>
              <div style={{ flex: 1 }}><strong>{r.a.patient}</strong> <span className="note">booked {r.a.lead} days ahead{r.a.newPt ? " · new patient" : ""}{r.pt.n ? ` · missed ${r.pt.missed} of ${r.pt.n} before` : ""}</span></div>
              <span className={"pill " + b[1]}>{b[0]} · {Math.round(r.p * 100)}%</span>
              {r.p >= 0.15 && (r.a.reminded ? <span className="pill good">Reminded</span> : <a className="btn small" href={waLink(`Hello, a reminder of your appointment at ${clinic} on ${new Date(r.a.date).toLocaleDateString()} at ${r.a.time}. Please reply YES to confirm or call us to change it.`, r.a.phone)} target="_blank" rel="noreferrer" onClick={() => setAppts(appts.map(x => x.id === r.a.id ? { ...x, reminded: true } : x))}>Remind</a>)}
              <button className="btn ghost small" title="Record what happened" onClick={() => { setHist([...hist, { patient: r.a.patient, date: r.a.date, hour: parseInt(r.a.time), lead: r.a.lead, newPt: r.a.newPt, showed: true }]); setAppts(appts.filter(x => x.id !== r.a.id)); }}>Came</button>
              <button className="btn ghost small danger" onClick={() => { setHist([...hist, { patient: r.a.patient, date: r.a.date, hour: parseInt(r.a.time), lead: r.a.lead, newPt: r.a.newPt, showed: false }]); setAppts(appts.filter(x => x.id !== r.a.id)); }}>No-show</button>
            </div>); })}
        </Section>); })}
      <div className="grid2">
        <Section title="Add a booking">
          <form className="stack" style={{ gap: 10 }} onSubmit={e => { e.preventDefault(); if (!d.patient.trim()) return; const lead = Math.max(0, Math.round((new Date(d.date).getTime() - new Date(todayISO()).getTime()) / 86400000)); setAppts([...appts, { id: uid(), ...d, patient: d.patient.trim(), lead }]); setD({ ...d, patient: "", phone: "" }); }}>
            <div className="row"><label className="field"><span>Patient ID or name</span><input id="su-p" className="input" value={d.patient} onChange={e => setD({ ...d, patient: e.target.value })} /></label><label className="field"><span>WhatsApp</span><input id="su-ph" className="input" value={d.phone} onChange={e => setD({ ...d, phone: e.target.value })} /></label></div>
            <div className="row" style={{ alignItems: "flex-end" }}><label className="field"><span>Date</span><input id="su-d" type="date" className="input" value={d.date} onChange={e => setD({ ...d, date: e.target.value })} /></label><label className="field"><span>Time</span><input id="su-t" type="time" className="input" value={d.time} onChange={e => setD({ ...d, time: e.target.value })} /></label><label className="check" style={{ paddingBottom: 10 }}><input type="checkbox" checked={d.newPt} onChange={e => setD({ ...d, newPt: e.target.checked })} />New patient</label><button className="btn primary" type="submit">Add</button></div>
          </form>
          <label className="field" style={{ marginTop: 10 }}><span>Clinic name</span><input id="su-c" className="input" value={clinic} onChange={e => setClinic(e.target.value)} /></label>
        </Section>
        <Section title="Import past appointments">
          <ImportBox label="CSV with patient, date, time, booked_on (or lead_days), attended (yes or no)" rows={4} placeholder={"patient,date,time,booked_on,attended\nP100,2026-05-02,09:00,2026-04-20,yes"} onText={t => setHist(csvObjects(t).map(r => { const lead = r.lead_days ? num(r.lead_days) : r.booked_on ? Math.max(0, Math.round((new Date(r.date).getTime() - new Date(r.booked_on).getTime()) / 86400000)) : 7; return { patient: r.patient || r.id || "?", date: r.date, hour: parseInt(r.time) || 10, lead, newPt: /^(y|yes|1|true)/i.test(r.new || ""), showed: /^(y|yes|1|true|attended|came)/i.test(r.attended || r.showed || "yes") }; }).filter(x => /^\d{4}-\d{2}-\d{2}/.test(x.date)))} />
          <p className="note" style={{ marginTop: 8 }}>Use patient ID numbers rather than names. Nothing leaves this device.</p>
        </Section>
      </div>
      <style>{`.su-bars{display:flex;gap:10px;align-items:flex-end;height:120px;padding-top:18px}.su-bars div{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;width:62px;position:relative}.su-bars span{width:26px;background:var(--warn);border-radius:3px 3px 0 0;max-height:100%}.su-bars em{font-style:normal;font-size:10px;color:var(--muted);text-align:center;height:26px}.su-bars b{position:absolute;top:0;font-size:11px}
      .su-row{display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}`}</style>
    </div>
  );
}
