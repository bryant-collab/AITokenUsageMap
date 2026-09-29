import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { line } from "d3-shape";
import { scaleLinear, scaleLog } from "d3-scale";
import type { DashboardResponse, DayResponse, DayTotal, HarnessId, ModelPricing, ModelPricingUpdate, ModelUsageRangeResponse, SummaryResponse, TokenUsage, WeeklyTotal } from "../shared/types";
import { billableUsageParts, cachedInputModeForHarness, calculateUsageCost } from "../shared/costMath";
import { addUsage, emptyUsage } from "../shared/tokenMath";
import { formatDateInput, parseDateInput, showNativeDatePicker } from "./dateInput";
import { capSpentUsd, dateInZone, readCapSettings, saveCapSettings } from "./capSettings";
import "./styles.css";

const tokenFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});

const fullFormat = new Intl.NumberFormat("en-US");

const usdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const smallUsdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
});

const formatTokens = (value: number): string => tokenFormat.format(value);

const formatUsd = (value: number | null): string => {
  if (value === null) return "Needs rates";
  if (value > 0 && value < 0.01) return smallUsdFormat.format(value);
  return usdFormat.format(value);
};

const HEATMAP_EMPTY_COLOR = "#ebedf0";
const HEATMAP_COLORS = ["#d9f0dd", "#bde5c4", "#94d79f", "#63c17d", "#32a866", "#16834b", "#075f34"];
const HEATMAP_BUCKETS = [1 / 1000, 1 / 300, 1 / 100, 1 / 30, 1 / 10, 1 / 3, 1];

const formatPercent = (value: number | null | undefined): string => {
  if (typeof value !== "number") return "n/a";
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
};

const formatTime = (timestamp: string | null | undefined): string => {
  if (!timestamp) return "No snapshot";
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
};

const addDays = (date: string, days: number): string => {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};

const rangeDays = (from: string, to: string): string[] => {
  const days: string[] = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    days.push(cursor);
  }
  return days;
};

const startOfWeek = (date: string): string => {
  const current = new Date(`${date}T00:00:00.000Z`);
  current.setUTCDate(current.getUTCDate() - current.getUTCDay());
  return current.toISOString().slice(0, 10);
};

const dateDiffDays = (from: string, to: string): number => {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((end - start) / 86_400_000);
};

const cellColor = (value: number, max: number): string => {
  if (value <= 0 || max <= 0) return HEATMAP_EMPTY_COLOR;
  const ratio = value / max;
  const bucket = HEATMAP_BUCKETS.findIndex((threshold) => ratio <= threshold);
  return HEATMAP_COLORS[bucket === -1 ? HEATMAP_COLORS.length - 1 : bucket];
};

const monthLabel = (date: string): string => {
  const month = Number(date.slice(5, 7));
  return ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][month - 1] ?? "";
};

const monthKey = (date: string): string => date.slice(0, 7);

const startOfMonth = (date: string): string => `${date.slice(0, 7)}-01`;

const endOfMonth = (date: string): string => {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCMonth(parsed.getUTCMonth() + 1, 0);
  return parsed.toISOString().slice(0, 10);
};

const selectedMonthStats = (summary: SummaryResponse, selectedDate: string | null) => {
  const activeDate = selectedDate ?? summary.today?.date ?? summary.peakDay?.date ?? summary.range.to;
  const monthStart = startOfMonth(activeDate);
  const monthEnd = endOfMonth(activeDate);
  const from = monthStart > summary.range.from ? monthStart : summary.range.from;
  const to = monthEnd < summary.range.to ? monthEnd : summary.range.to;
  const days = summary.daily.filter((day) => day.date >= monthStart && day.date <= monthEnd);
  const totals = days.reduce((acc, day) => addUsage(acc, day), emptyUsage());
  const peakDay = days.reduce<DayTotal | null>((peak, day) => (!peak || day.totalTokens > peak.totalTokens ? day : peak), null);

  return { totals, peakDay, from, to };
};

type CostRow = TokenUsage & {
  model: string;
  dates: Set<string>;
  harnesses: Set<string>;
  events: number;
  billableInputTokens: number;
  billableCachedInputTokens: number;
  billableOutputTokens: number;
  totalCostUsd: number | null;
};

const emptyCostRow = (model: string): CostRow => ({
  ...emptyUsage(),
  model,
  dates: new Set<string>(),
  harnesses: new Set<string>(),
  events: 0,
  billableInputTokens: 0,
  billableCachedInputTokens: 0,
  billableOutputTokens: 0,
  totalCostUsd: 0
});

const pricingSourceLabel = (pricing: ModelPricing | null | undefined): string => {
  if (!pricing) return "Loading";
  if (pricing.source === "catalog") return "Official";
  if (pricing.source === "manual") return "Manual";
  return "Missing";
};

const numericRateText = (value: number | null | undefined): string => (
  typeof value === "number" && Number.isFinite(value) ? String(value) : ""
);

const parseRate = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <section className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}

function MiniStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="miniStat">
      <strong>{value}</strong>
      <span>{label}</span>
      <small>{detail}</small>
    </div>
  );
}

function TokenBreakdown({
  usage,
  totalLabel = "Total",
  totalDetail = "Source-reported total",
  compact = false
}: {
  usage: TokenUsage;
  totalLabel?: string;
  totalDetail?: string;
  compact?: boolean;
}) {
  const items = [
    { label: totalLabel, value: usage.totalTokens, detail: totalDetail },
    { label: "Input", value: usage.inputTokens, detail: "Prompt and context" },
    { label: "Cached input", value: usage.cachedInputTokens, detail: "Reused context" },
    { label: "Output", value: usage.outputTokens, detail: "Model response" },
    { label: "Reasoning", value: usage.reasoningOutputTokens, detail: "When logged separately" }
  ];

  return (
    <section className={compact ? "tokenBreakdown compact" : "tokenBreakdown"} aria-label={`${totalLabel} token breakdown`}>
      {items.map((item) => (
        <div className="tokenMetric" key={item.label}>
          <strong>{formatTokens(item.value)}</strong>
          <span>{item.label}</span>
          <small>{item.detail}</small>
        </div>
      ))}
    </section>
  );
}

function SessionTokenMix({ usage }: { usage: TokenUsage }) {
  const items = [
    ["Input", usage.inputTokens],
    ["Output", usage.outputTokens],
    ["Cached", usage.cachedInputTokens],
    ["Total", usage.totalTokens]
  ] as const;
  const visibleItems = usage.reasoningOutputTokens > 0
    ? [...items.slice(0, 3), ["Reason", usage.reasoningOutputTokens] as const, items[3]]
    : items;

  return (
    <div className="sessionUsage" aria-label="Session token breakdown">
      {visibleItems.map(([label, value]) => (
        <span key={label}>
          <strong>{formatTokens(value)}</strong>
          {label}
        </span>
      ))}
    </div>
  );
}

function WeeklyLine({ weekly }: { weekly: WeeklyTotal[] }) {
  const width = 980;
  const height = 132;
  const pad = { left: 22, right: 28, top: 12, bottom: 24 };
  const max = Math.max(1, ...weekly.map((week) => week.totalTokens));
  const x = scaleLinear().domain([0, Math.max(1, weekly.length - 1)]).range([pad.left, width - pad.right]);
  const y = scaleLog().domain([1, Math.max(2, max)]).range([height - pad.bottom, pad.top]);
  const path = line<WeeklyTotal>()
    .x((_week, index) => x(index))
    .y((week) => y(Math.max(1, week.totalTokens)))(weekly) ?? "";
  const monthTicks = weekly.filter((week, index) => index === 0 || monthKey(week.weekStart) !== monthKey(weekly[index - 1].weekStart));

  return (
    <div className="lineChart" aria-label="Weekly total token line chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} />
        <path d={path} />
        {weekly.map((week, index) => (
          <circle key={week.weekStart} cx={x(index)} cy={y(Math.max(1, week.totalTokens))} r={3}>
            <title>{`${week.weekStart}: ${fullFormat.format(week.totalTokens)} tokens`}</title>
          </circle>
        ))}
        {monthTicks.map((week) => {
          const index = weekly.indexOf(week);
          const anchor = index === 0 ? "start" : index === weekly.length - 1 ? "end" : "middle";
          return (
            <text key={week.weekStart} x={x(index)} y={height - 6} textAnchor={anchor}>
              {monthLabel(week.weekStart)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function Heatmap({
  days,
  daily,
  selectedDate,
  onSelect
}: {
  days: string[];
  daily: Map<string, DayTotal>;
  selectedDate: string | null;
  onSelect: (date: string) => void;
}) {
  const cell = 14;
  const gap = 3;
  const top = 0;
  const gridStart = days.length > 0 ? startOfWeek(days[0]) : "";
  const gridEnd = days.length > 0 ? days[days.length - 1] : "";
  const rangeKey = days.length > 0 ? `${gridStart}:${gridEnd}` : "";
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const weeks = days.length > 0 ? Math.floor(dateDiffDays(gridStart, gridEnd) / 7) + 1 : 0;
  const width = weeks * (cell + gap) + 12;
  const height = top + 7 * (cell + gap) + 8;
  const max = Math.max(0, ...[...daily.values()].map((day) => day.totalTokens));

  useLayoutEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollLeft = scrollContainer.scrollWidth;
  }, [rangeKey]);

  return (
    <div className="heatmapGrid">
      <div className="weekdayLabels" aria-hidden="true">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="heatmapWrap" ref={scrollRef}>
        <svg viewBox={`0 0 ${width} ${height}`} className="heatmap" role="img" aria-label="Daily token usage heatmap">
          {days.map((date) => {
            const week = Math.floor(dateDiffDays(gridStart, date) / 7);
            const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
            const total = daily.get(date);
            const tokens = total?.totalTokens ?? 0;
            const x = week * (cell + gap);
            const y = top + weekday * (cell + gap);
            return (
              <rect
                key={date}
                className={selectedDate === date ? "selectedCell" : ""}
                x={x}
                y={y}
                width={cell}
                height={cell}
                rx={2}
                fill={cellColor(tokens, max)}
                onClick={() => onSelect(date)}
                tabIndex={0}
                role="button"
                aria-label={`${date}: ${tokens} tokens`}
              >
                <title>{`${date}: ${fullFormat.format(tokens)} tokens, ${total?.events ?? 0} events`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function CaveatsDisclosure({ summary }: { summary: SummaryResponse }) {
  const confidence = summary.harness.confidence;
  if (!confidence && summary.harness.caveats.length === 0) return null;

  return (
    <details className="caveatsDisclosure">
      <summary>
        <span>Why these numbers can mislead</span>
        <small>{summary.harness.usageLabel}</small>
      </summary>
      {confidence && (
        <div className="caveatGrid" aria-label={`${summary.harness.name} confidence`}>
          <div>
            <strong>Captured local requests</strong>
            <p>{confidence.captured}</p>
          </div>
          <div>
            <strong>Total personal usage</strong>
            <p>{confidence.total}</p>
          </div>
          <div>
            <strong>Billing reconciliation</strong>
            <p>{confidence.billing}</p>
          </div>
        </div>
      )}
      {summary.harness.caveats.length > 0 && (
        <ul>
          {summary.harness.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
        </ul>
      )}
    </details>
  );
}

function PricingInputs({
  model,
  pricing,
  onSavePricing
}: {
  model: string;
  pricing: ModelPricing | null | undefined;
  onSavePricing: (update: ModelPricingUpdate) => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    input: numericRateText(pricing?.inputUsdPerMillion),
    cached: numericRateText(pricing?.cachedInputUsdPerMillion),
    output: numericRateText(pricing?.outputUsdPerMillion)
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setDraft({
      input: numericRateText(pricing?.inputUsdPerMillion),
      cached: numericRateText(pricing?.cachedInputUsdPerMillion),
      output: numericRateText(pricing?.outputUsdPerMillion)
    });
  }, [model, pricing?.cachedAt, pricing?.updatedAt]);

  const inputRate = parseRate(draft.input);
  const cachedRate = parseRate(draft.cached);
  const outputRate = parseRate(draft.output);
  const canSave = inputRate !== null && outputRate !== null;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSavePricing({
        model,
        inputUsdPerMillion: inputRate,
        cachedInputUsdPerMillion: cachedRate,
        outputUsdPerMillion: outputRate
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="pricingInputs" onSubmit={save}>
      <input
        aria-label={`${model} input dollars per million tokens`}
        inputMode="decimal"
        min="0"
        step="0.0001"
        type="number"
        placeholder="Input"
        value={draft.input}
        onChange={(event) => setDraft((current) => ({ ...current, input: event.target.value }))}
      />
      <input
        aria-label={`${model} cached input dollars per million tokens`}
        inputMode="decimal"
        min="0"
        step="0.0001"
        type="number"
        placeholder="Cached"
        value={draft.cached}
        onChange={(event) => setDraft((current) => ({ ...current, cached: event.target.value }))}
      />
      <input
        aria-label={`${model} output dollars per million tokens`}
        inputMode="decimal"
        min="0"
        step="0.0001"
        type="number"
        placeholder="Output"
        value={draft.output}
        onChange={(event) => setDraft((current) => ({ ...current, output: event.target.value }))}
      />
      <button type="submit" disabled={!canSave || saving}>{saving ? "Saving" : "Save"}</button>
      {saveError && <small>{saveError}</small>}
    </form>
  );
}

function DateRangeField({
  label,
  text,
  parsedDate,
  min,
  max,
  onTextChange
}: {
  label: string;
  text: string;
  parsedDate: string | null;
  min?: string;
  max?: string;
  onTextChange: (value: string) => void;
}) {
  const pickerRef = useRef<HTMLInputElement | null>(null);

  return (
    <label className="dateRangeField">
      <span>{label}</span>
      <div className="dateRangeInput">
        <input
          aria-label={`${label} date`}
          inputMode="numeric"
          placeholder="MM/DD/YYYY"
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
        />
        <button type="button" onClick={() => showNativeDatePicker(pickerRef.current)} aria-label={`Pick ${label.toLowerCase()} date`}>Calendar</button>
        <input
          ref={pickerRef}
          className="calendarNativeInput"
          type="date"
          min={min}
          max={max}
          value={parsedDate ?? ""}
          onChange={(event) => {
            if (event.target.value) onTextChange(formatDateInput(event.target.value));
          }}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
    </label>
  );
}

function CostAnalysisPanel({
  dashboardRange,
  range,
  usage,
  loading,
  error,
  pricingByModel,
  onRangeChange,
  onSavePricing
}: {
  dashboardRange: DashboardResponse["range"];
  range: { from: string; to: string } | null;
  usage: ModelUsageRangeResponse | null;
  loading: boolean;
  error: string | null;
  pricingByModel: Record<string, ModelPricing>;
  onRangeChange: (range: { from: string; to: string }) => void;
  onSavePricing: (update: ModelPricingUpdate) => Promise<void>;
}) {
  const [startText, setStartText] = useState(range ? formatDateInput(range.from) : "");
  const [endText, setEndText] = useState(range ? formatDateInput(range.to) : "");
  const startDate = parseDateInput(startText);
  const endDate = parseDateInput(endText);
  const validRange = Boolean(startDate && endDate && endDate >= startDate);

  useEffect(() => {
    if (!range) return;
    setStartText(formatDateInput(range.from));
    setEndText(formatDateInput(range.to));
  }, [range?.from, range?.to]);

  useEffect(() => {
    if (!startDate || !endDate || endDate < startDate) return;
    if (range?.from !== startDate || range?.to !== endDate) {
      onRangeChange({ from: startDate, to: endDate });
    }
  }, [endDate, onRangeChange, range?.from, range?.to, startDate]);

  const activeUsage = validRange && usage?.range.from === startDate && usage.range.to === endDate ? usage : null;
  const rows = useMemo(() => {
    const byModel = new Map<string, CostRow>();
    for (const item of activeUsage?.rows ?? []) {
      let row = byModel.get(item.model);
      if (!row) {
        row = emptyCostRow(item.model);
        byModel.set(item.model, row);
      }

      addUsage(row, item);
      row.dates.add(item.date);
      row.harnesses.add(item.harness.name);
      row.events += item.events;

      const pricing = pricingByModel[item.model];
      const parts = billableUsageParts(item, cachedInputModeForHarness(item.harness.id));
      row.billableInputTokens += parts.inputTokens;
      row.billableCachedInputTokens += parts.cachedInputTokens;
      row.billableOutputTokens += parts.outputTokens;

      const cost = pricing
        ? calculateUsageCost(item, pricing, cachedInputModeForHarness(item.harness.id)).totalCostUsd
        : null;
      row.totalCostUsd = row.totalCostUsd === null || cost === null
        ? null
        : row.totalCostUsd + cost;
    }

    return [...byModel.values()].sort((a, b) => {
      const costSort = (b.totalCostUsd ?? -1) - (a.totalCostUsd ?? -1);
      return costSort || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model);
    });
  }, [activeUsage, pricingByModel]);

  const knownCost = rows.reduce((sum, row) => sum + (row.totalCostUsd ?? 0), 0);
  const needsRates = rows.filter((row) => row.totalCostUsd === null).length;
  const lookupModels = rows.filter((row) => pricingByModel[row.model]?.source === "catalog").length;
  const validationMessage = !startText.trim() || !endText.trim()
    ? "Choose a start and end date."
    : !startDate
      ? "Start date must be a valid date."
      : !endDate
        ? "End date must be a valid date."
        : endDate < startDate
          ? "End date must be on or after start date."
          : null;
  const totalValue = !validRange || loading || !activeUsage ? "Pending" : `${needsRates > 0 ? "≥" : ""}${formatUsd(knownCost)}`;
  const totalDetail = !validRange
    ? "Waiting for valid range"
    : loading || !activeUsage
      ? "Loading range"
      : needsRates > 0
        ? `Known cost only · ${needsRates} model${needsRates === 1 ? "" : "s"} need rates`
        : "All selected models";

  return (
    <section className="panel costPanel">
      <div className="panelHead">
        <div>
          <h2>Cost analysis</h2>
          <p>{validRange ? `${startDate} to ${endDate}` : `${dashboardRange.from} to ${dashboardRange.to}`}</p>
        </div>
        <div className="costTotals">
          <MiniStat label="Total estimated cost · selected dates" value={totalValue} detail={totalDetail} />
          <MiniStat label="Official rates" value={fullFormat.format(lookupModels)} detail="Live source or verified fallback" />
        </div>
      </div>

      <div className="dateRangeControls">
        <DateRangeField label="Start" text={startText} parsedDate={startDate} onTextChange={setStartText} />
        <DateRangeField label="End" text={endText} parsedDate={endDate} min={startDate ?? undefined} onTextChange={setEndText} />
      </div>

      {validationMessage && <div className="inlineNotice">{validationMessage}</div>}
      {error && <div className="inlineNotice errorText">{error}</div>}
      {loading && validRange && <div className="emptyPanel">Loading cost range...</div>}

      {!loading && !validationMessage && activeUsage && rows.length > 0 ? (
        <div className="costTableWrap">
          <table className="costTable">
            <colgroup>
              <col className="costModelColumn" />
              <col className="costActivityColumn" />
              <col className="costTokensColumn" />
              <col className="costRatesColumn" />
              <col className="costAmountColumn" />
            </colgroup>
            <thead>
              <tr>
                <th>Model</th>
                <th>Activity</th>
                <th>Billable tokens</th>
                <th>Rates $/1M</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const pricing = pricingByModel[row.model];
                return (
                  <tr key={row.model}>
                    <td>
                      <strong title={row.model}>{row.model}</strong>
                      <small>{[...row.harnesses].sort().join(", ")}</small>
                      <span className={`sourceBadge source-${pricing?.source ?? "loading"}`}>{pricingSourceLabel(pricing)}</span>
                    </td>
                    <td>
                      <span>{fullFormat.format(row.dates.size)} day{row.dates.size === 1 ? "" : "s"}</span>
                      <span>{fullFormat.format(row.events)} events</span>
                    </td>
                    <td>
                      <span>In {formatTokens(row.billableInputTokens)}</span>
                      <span>Cached {formatTokens(row.billableCachedInputTokens)}</span>
                      <span>Out {formatTokens(row.billableOutputTokens)}</span>
                    </td>
                    <td className="costRateCell">
                      <PricingInputs model={row.model} pricing={pricing} onSavePricing={onSavePricing} />
                      {pricing?.sourceUrl && (
                        <small>
                          <a href={pricing.sourceUrl} target="_blank" rel="noreferrer">
                            {pricing.source === "catalog"
                              ? `Official ${pricing.provider} rate, checked ${pricing.updatedAt}`
                              : "GitHub's official pricing explanation"}
                          </a>
                        </small>
                      )}
                      {pricing?.notes.map((note) => <small key={note}>{note}</small>)}
                    </td>
                    <td className="costValue">{formatUsd(row.totalCostUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : !loading && !validationMessage && activeUsage ? (
        <div className="emptyPanel">No model usage found for this range.</div>
      ) : null}
      {!loading && validRange && !activeUsage && (
        <div className="emptyPanel">Loading cost range...</div>
      )}
      <p className="costFootnote">Estimates use official standard per-token rates. Subscription allowances, long-context requests, regional routing, batch discounts, cache writes, and Copilot code review's undisclosed model may differ from this local estimate.</p>
    </section>
  );
}

function DayDetails({ day }: { day: DayResponse | null }) {
  if (!day) return <aside className="details emptyPanel">No day selected.</aside>;
  if (!day.totals) return <aside className="details emptyPanel">No {day.harness.name} token events for {day.date}.</aside>;
  const hasRateLimit = Boolean(day.rateLimit.latestForDay || day.harness.id === "codex");

  return (
    <aside className="details">
      <div className="detailsHead">
        <span>{day.date}</span>
        <strong>{formatTokens(day.totals.totalTokens)}</strong>
      </div>
      <TokenBreakdown usage={day.totals} totalLabel="Day total" compact />
      {hasRateLimit && (
        <section className="rateSummary">
          <h3>Selected day limit snapshot</h3>
          <div className="rateGrid">
            <MiniStat
              label="5h used %"
              value={formatPercent(day.rateLimit.latestForDay?.primary?.usedPercent)}
              detail={formatTime(day.rateLimit.latestForDay?.timestamp)}
            />
            <MiniStat
              label="Weekly used %"
              value={formatPercent(day.rateLimit.latestForDay?.secondary?.usedPercent)}
              detail="Latest observed that day"
            />
            <MiniStat
              label="Week-to-date"
              value={formatTokens(day.rateLimit.weekToDate.totalTokens)}
              detail={`${day.rateLimit.weekToDate.weekStart} to ${day.rateLimit.weekToDate.through}`}
            />
          </div>
        </section>
      )}
      <table>
        <colgroup>
          <col className="sessionColumn" />
          <col className="modelColumn" />
          <col className="tokenMixColumn" />
        </colgroup>
        <thead>
          <tr>
            <th>Session</th>
            <th>Model</th>
            <th>Token mix</th>
          </tr>
        </thead>
        <tbody>
          {day.sessions.map((session) => (
            <tr key={`${session.sessionId}-${session.model}`}>
              <td className="ellipsisCell" title={session.cwd ?? session.sessionId}>{session.cwd ? session.cwd.split(/[\\/]/).slice(-2).join("/") : session.sessionId.slice(0, 8)}</td>
              <td className="ellipsisCell" title={session.model}>{session.model}</td>
              <td className="tokenMixCell"><SessionTokenMix usage={session} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  );
}

function HarnessDashboard({
  summary,
  selectedDate,
  day,
  onSelectDate
}: {
  summary: SummaryResponse;
  selectedDate: string | null;
  day: DayResponse | null;
  onSelectDate: (harness: HarnessId, date: string) => void;
}) {
  const dailyMap = useMemo(() => new Map(summary.daily.map((item) => [item.date, item])), [summary]);
  const days = useMemo(() => rangeDays(summary.range.from, summary.range.to), [summary]);
  const monthlyStats = useMemo(() => selectedMonthStats(summary, selectedDate), [summary, selectedDate]);

  return (
    <section className="harnessSection">
      <div className="harnessHead">
        <div>
          <span className="harnessBadge">{summary.harness.usageLabel}</span>
          <h2>{summary.harness.name}</h2>
          <p>{summary.harness.description}</p>
        </div>
      </div>

      <section className="stats">
        <Stat label="Today" value={formatTokens(summary.today?.totalTokens ?? 0)} detail={summary.today ? `${summary.today.events} events` : "No events yet"} />
        <Stat label="Last hour" value={formatTokens(summary.lastHour.totalTokens)} detail="Recent local events" />
        <Stat label="Last 7 days" value={formatTokens(summary.lastSevenDays.totalTokens)} detail="Rolling total" />
        <Stat label="Monthly peak day" value={monthlyStats.peakDay ? formatTokens(monthlyStats.peakDay.totalTokens) : "0"} detail={monthlyStats.peakDay?.date ?? "No peak this month"} />
        <Stat label="Monthly total" value={formatTokens(monthlyStats.totals.totalTokens)} detail={`${monthlyStats.from} to ${monthlyStats.to}`} />
      </section>

      <TokenBreakdown usage={monthlyStats.totals} totalLabel="Month total" totalDetail={`${monthlyStats.from} to ${monthlyStats.to}`} />
      <CaveatsDisclosure summary={summary} />

      <section className="panel">
        <div className="panelHead">
          <div>
            <h2>Daily token burn</h2>
            <p>{summary.range.from} to {summary.range.to}</p>
          </div>
          <div className="legend">
            <span>Less</span>
            <i style={{ background: HEATMAP_EMPTY_COLOR }} />
            {HEATMAP_COLORS.map((color) => <i key={color} style={{ background: color }} />)}
            <span>More</span>
          </div>
        </div>
        <WeeklyLine weekly={summary.weekly} />
        <div className="contentGrid">
          <Heatmap days={days} daily={dailyMap} selectedDate={selectedDate} onSelect={(date) => onSelectDate(summary.harness.id, date)} />
          <DayDetails day={day} />
        </div>
      </section>

      <section className="diagnosticsPanel">
        <div className="diagnosticsHead">
          <div>
            <h2>Scanner health</h2>
            <p>Local {summary.harness.name} log scan and cache status.</p>
          </div>
          <span>{summary.diagnostics.lastScanCompletedAt ? formatTime(summary.diagnostics.lastScanCompletedAt) : "Not scanned"}</span>
        </div>
        <div className="diagnostics">
          <MiniStat label="Files found" value={fullFormat.format(summary.diagnostics.filesScanned)} detail="Candidate logs" />
          <MiniStat label="Loaded from cache" value={fullFormat.format(summary.diagnostics.filesFromCache)} detail="Unchanged files" />
          <MiniStat label="Parsed this scan" value={fullFormat.format(summary.diagnostics.filesParsed)} detail="Changed or new files" />
          <MiniStat label="Skipped files" value={fullFormat.format(summary.diagnostics.skippedFiles)} detail="Unreadable files" />
          <MiniStat label="Parse errors" value={fullFormat.format(summary.diagnostics.parseErrors)} detail="Malformed JSONL lines" />
          <MiniStat label="Token events" value={fullFormat.format(summary.diagnostics.tokenEvents)} detail="Counted usage events" />
        </div>
      </section>
    </section>
  );
}

function App() {
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [activeTab, setActiveTab] = useState<HarnessId | "cost" | null>(null);
  const [selectedDates, setSelectedDates] = useState<Partial<Record<HarnessId, string>>>({});
  const [daysByHarness, setDaysByHarness] = useState<Partial<Record<HarnessId, DayResponse>>>({});
  const [pricingByModel, setPricingByModel] = useState<Record<string, ModelPricing>>({});
  const [costRange, setCostRange] = useState<{ from: string; to: string } | null>(null);
  const [costUsage, setCostUsage] = useState<ModelUsageRangeResponse | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  const [costError, setCostError] = useState<string | null>(null);
  const [costReloadToken, setCostReloadToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [capSettings, setCapSettings] = useState(readCapSettings);
  const [capLimitText, setCapLimitText] = useState(() => String(readCapSettings().limitUsd ?? ""));
  const [refreshText, setRefreshText] = useState(() => String(readCapSettings().refreshMinutes ?? 60));
  const [capUsage, setCapUsage] = useState<ModelUsageRangeResponse | null>(null);
  const [capPricing, setCapPricing] = useState<Record<string, ModelPricing>>({});
  const [capError, setCapError] = useState<string | null>(null);
  const [capTick, setCapTick] = useState(0);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const scanInFlight = useRef(false);
  const today = dashboard ? dateInZone(dashboard.range.timezone, currentTime) : null;
  const month = today?.slice(0, 7) ?? null;
  const capRows = capUsage?.range.from === `${month}-01` && capUsage.range.to === today ? capUsage.rows : null;
  const capCost = capRows?.reduce((sum, row) => {
    const pricing = capPricing[row.model] ?? pricingByModel[row.model];
    const cost = pricing ? calculateUsageCost(row, pricing, cachedInputModeForHarness(row.harness.id)).totalCostUsd : null;
    return sum + (cost ?? 0);
  }, 0) ?? null;
  const capMissingRates = capRows?.some((row) => {
    const pricing = capPricing[row.model] ?? pricingByModel[row.model];
    return !pricing || calculateUsageCost(row, pricing, cachedInputModeForHarness(row.harness.id)).totalCostUsd === null;
  }) ?? false;
  const capSpent = capCost !== null && month ? capSpentUsd(capCost, capSettings, month) : null;
  const selectedModels = useMemo(() => {
    const models = new Set<string>();
    for (const row of costUsage?.rows ?? []) {
      models.add(row.model);
    }
    return [...models].sort();
  }, [costUsage]);
  const selectedModelKey = selectedModels.join("\0");
  const tabOrder = useMemo<Array<HarnessId | "cost">>(() => [
    ...(dashboard?.harnesses.map((summary) => summary.harness.id) ?? []),
    "cost"
  ], [dashboard]);

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, tab: HarnessId | "cost") => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = tabOrder.indexOf(tab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabOrder.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabOrder.length) % tabOrder.length;
    const nextTab = tabOrder[nextIndex];
    if (!nextTab) return;
    setActiveTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`tab-${nextTab}`)?.focus());
  };

  const loadSummary = async () => {
    setError(null);
    const data = await window.desktopApi.getSummary();
    setDashboard(data);
    setSelectedDates((current) => Object.fromEntries(data.harnesses.map((summary) => [
      summary.harness.id,
      current[summary.harness.id] ?? summary.today?.date ?? summary.peakDay?.date ?? data.range.to
    ])) as Partial<Record<HarnessId, string>>);
    setActiveTab((current) => {
      if (current === "cost" || data.harnesses.some((summary) => summary.harness.id === current)) return current;
      return data.harnesses[0]?.harness.id ?? null;
    });
    setCostRange((current) => current ?? { from: data.range.to, to: data.range.to });
    setLoading(false);
  };

  useEffect(() => {
    loadSummary().catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    saveCapSettings(capSettings);
  }, [capSettings]);

  useEffect(() => {
    if (!today || !month || capSettings.limitUsd === null) return;
    let current = true;
    setCapError(null);
    window.desktopApi.getModelUsage(`${month}-01`, today)
      .then(async (data) => {
        const models = [...new Set(data.rows.map((row) => row.model))];
        const rates = models.length ? await window.desktopApi.getPricing(models) : { rates: [] };
        if (!current) return;
        setCapUsage(data);
        setCapPricing(Object.fromEntries(rates.rates.map((rate) => [rate.model, rate])));
      })
      .catch((err) => {
        if (current) setCapError(err instanceof Error ? err.message : "Failed to calculate the monthly cap");
      });
    return () => { current = false; };
  }, [today, month, capSettings.limitUsd, capTick]);

  useEffect(() => {
    if (capSettings.refreshMinutes === null) return;
    const interval = window.setInterval(() => { void rescan(false); }, capSettings.refreshMinutes * 60_000);
    return () => window.clearInterval(interval);
  }, [capSettings.refreshMinutes]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setCurrentTime(new Date());
    }, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!activeTab || activeTab === "cost") return;
    const selectedDate = selectedDates[activeTab];
    if (!selectedDate) return;

    let current = true;
    window.desktopApi.getDay(activeTab, selectedDate)
      .then((data: DayResponse) => {
        if (current) setDaysByHarness((days) => ({ ...days, [activeTab]: data }));
      })
      .catch(() => {
        if (!current) return;
        setDaysByHarness((days) => {
          const next = { ...days };
          delete next[activeTab];
          return next;
        });
      });

    return () => {
      current = false;
    };
  }, [activeTab, selectedDates]);

  useEffect(() => {
    if (!costRange || activeTab !== "cost") return;

    let current = true;
    setCostLoading(true);
    setCostError(null);
    window.desktopApi.getModelUsage(costRange.from, costRange.to)
      .then((data) => {
        if (!current) return;
        setCostUsage(data);
        setCostLoading(false);
      })
      .catch((err) => {
        if (!current) return;
        setCostError(err instanceof Error ? err.message : "Failed to load cost range");
        setCostLoading(false);
      });

    return () => {
      current = false;
    };
  }, [activeTab, costRange, costReloadToken]);

  useEffect(() => {
    if (activeTab !== "cost") return;
    const missingModels = selectedModels.filter((model) => !pricingByModel[model]);
    if (missingModels.length === 0) return;

    let current = true;
    setPricingError(null);
    window.desktopApi.getPricing(missingModels)
      .then((data) => {
        if (!current) return;
        setPricingByModel((rates) => {
        const next = { ...rates };
        for (const rate of data.rates) {
          next[rate.model] = rate;
        }
        return next;
        });
      })
      .catch((err) => {
        if (!current) return;
        setPricingError(err instanceof Error ? err.message : "Failed to load pricing");
      });

    return () => {
      current = false;
    };
  }, [activeTab, pricingByModel, selectedModelKey, selectedModels]);

  const selectDate = (harness: HarnessId, date: string) => {
    setSelectedDates((current) => ({ ...current, [harness]: date }));
  };

  const selectCostRange = useCallback((range: { from: string; to: string }) => {
    setCostRange((current) => (
      current?.from === range.from && current.to === range.to ? current : range
    ));
  }, []);

  const savePricing = async (update: ModelPricingUpdate) => {
    const rate = await window.desktopApi.savePricing(update);
    setPricingByModel((current) => ({ ...current, [rate.model]: rate }));
    setCapPricing((current) => ({ ...current, [rate.model]: rate }));
  };

  const rescan = async (force = true) => {
    if (scanInFlight.current) return;
    scanInFlight.current = true;
    setRescanning(true);
    setError(null);
    try {
      await window.desktopApi.rescan(force);
      await loadSummary();
      setCostReloadToken((current) => current + 1);
      setCapTick((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rescan local logs");
    } finally {
      setRescanning(false);
      scanInFlight.current = false;
    }
  };

  const saveCap = (event: React.FormEvent) => {
    event.preventDefault();
    const limit = Number(capLimitText);
    if (!Number.isFinite(limit) || limit <= 0) return;
    setCapSettings((current) => ({ ...current, limitUsd: limit }));
  };

  const saveRefresh = (event: React.FormEvent) => {
    event.preventDefault();
    const minutes = Number(refreshText);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) return;
    setCapSettings((current) => ({ ...current, refreshMinutes: minutes }));
  };

  if (loading) return <main className="shell"><div className="emptyPanel">Scanning local AI usage logs...</div></main>;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>AI Token Usage</h1>
          <p>Local token usage from detected AI coding harness logs.</p>
        </div>
        <button onClick={() => { void rescan(); }} disabled={rescanning}>{rescanning ? "Rescanning" : "Rescan"}</button>
      </header>

      <section className="usageControls" aria-label="Cost limit and scanning">
        <form onSubmit={saveCap}>
          <label htmlFor="cost-limit">Monthly cost alert (USD)</label>
          <input id="cost-limit" type="number" min="0.01" step="0.01" value={capLimitText} onChange={(event) => setCapLimitText(event.target.value)} placeholder="No limit" />
          <button type="submit">Set limit</button>
          {capSettings.limitUsd !== null && <button type="button" onClick={() => { setCapSettings((current) => ({ ...current, limitUsd: null })); setCapLimitText(""); }}>Clear</button>}
        </form>
        <form onSubmit={saveRefresh}>
          <label htmlFor="refresh-minutes">Scan logs</label>
          <select value={capSettings.refreshMinutes === null ? "manual" : "automatic"} onChange={(event) => setCapSettings((current) => ({ ...current, refreshMinutes: event.target.value === "manual" ? null : Number(refreshText) || 60 }))}>
            <option value="manual">Manually</option>
            <option value="automatic">Automatically every</option>
          </select>
          {capSettings.refreshMinutes !== null && <><input id="refresh-minutes" type="number" min="1" max="10080" step="1" value={refreshText} onChange={(event) => setRefreshText(event.target.value)} aria-label="Scan interval in minutes" /><span>minutes</span><button type="submit">Save</button></>}
        </form>
      </section>

      {capSettings.limitUsd !== null && (
        <div className={`capNotice ${capSpent !== null && capSpent >= capSettings.limitUsd ? "capReached" : ""}`} role={capSpent !== null && capSpent >= capSettings.limitUsd ? "alert" : "status"}>
          <div>
            <strong>{capSpent !== null && capSpent >= capSettings.limitUsd ? "Monthly cost alert reached" : "Monthly cost alert"}</strong>
            <span>{capSpent === null ? "Calculating this month's usage…" : `${formatUsd(capSpent)} of ${formatUsd(capSettings.limitUsd)} since ${capSettings.resetMonth === month ? "your last reset" : "the first of the month"}${capMissingRates ? " · Some models need rates, so actual cost may be higher." : ""}`}</span>
            {capError && <span>{capError}</span>}
          </div>
          <button type="button" disabled={capCost === null} onClick={() => { if (month && capCost !== null) setCapSettings((current) => ({ ...current, resetMonth: month, resetBaselineUsd: capCost })); }}>Reset now</button>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {pricingError && <div className="error">{pricingError}</div>}

      {dashboard && dashboard.harnesses.length > 0 ? (
        <>
          <nav className="providerTabs" role="tablist" aria-label="Usage views">
            {dashboard.harnesses.map((summary) => (
              <button
                id={`tab-${summary.harness.id}`}
                key={summary.harness.id}
                type="button"
                role="tab"
                aria-selected={activeTab === summary.harness.id}
                aria-controls={`panel-${summary.harness.id}`}
                tabIndex={activeTab === summary.harness.id ? 0 : -1}
                className={activeTab === summary.harness.id ? "active" : ""}
                onClick={() => setActiveTab(summary.harness.id)}
                onKeyDown={(event) => handleTabKeyDown(event, summary.harness.id)}
              >
                {summary.harness.name}
              </button>
            ))}
            <button
              id="tab-cost"
              type="button"
              role="tab"
              aria-selected={activeTab === "cost"}
              aria-controls="panel-cost"
              tabIndex={activeTab === "cost" ? 0 : -1}
              className={activeTab === "cost" ? "active" : ""}
              onClick={() => setActiveTab("cost")}
              onKeyDown={(event) => handleTabKeyDown(event, "cost")}
            >
              Cost Calculator
            </button>
          </nav>

          {dashboard.harnesses.map((summary) => activeTab === summary.harness.id && (
            <div
              id={`panel-${summary.harness.id}`}
              key={summary.harness.id}
              role="tabpanel"
              aria-labelledby={`tab-${summary.harness.id}`}
            >
              <HarnessDashboard
                summary={summary}
                selectedDate={selectedDates[summary.harness.id] ?? null}
                day={daysByHarness[summary.harness.id] ?? null}
                onSelectDate={selectDate}
              />
            </div>
          ))}

          {activeTab === "cost" && (
            <div id="panel-cost" role="tabpanel" aria-labelledby="tab-cost">
              <CostAnalysisPanel
                dashboardRange={dashboard.range}
                range={costRange}
                usage={costUsage}
                loading={costLoading}
                error={costError}
                pricingByModel={pricingByModel}
                onRangeChange={selectCostRange}
                onSavePricing={savePricing}
              />
            </div>
          )}
        </>
      ) : (
        <div className="emptyPanel">No Codex, GitHub Copilot, or Claude Code token logs were found on this machine.</div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
