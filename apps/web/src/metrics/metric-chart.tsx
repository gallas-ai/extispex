import type { QueryMetricResponse } from "@extispex/contracts";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "react";
import { formatMetricValue } from "./metric-formatting.ts";
import type { ChartTheme } from "./use-chart-theme.ts";

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);

export interface ChartSeries {
  label: string;
  colorSlot: number;
  values: (number | null)[];
}

interface MetricChartProps {
  result: QueryMetricResponse;
  series: ChartSeries[];
  unitLabel: string;
  theme: ChartTheme;
  description: string;
}

/** Up to this many series carry their name at the end of the line, as well as in the legend. */
const MAXIMUM_DIRECT_LABELS = 4;
/** Below this width the lines need the room that their end labels would take. */
const MINIMUM_DIRECT_LABEL_CHART_WIDTH = 560;
const LEGEND_LABEL_WIDTH = 160;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function MetricChart({ result, series, unitLabel, theme, description }: MetricChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [isWide, setIsWide] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart = echarts.init(container, null, { renderer: "svg" });
    chartRef.current = chart;
    const resizeObserver = new ResizeObserver(() => {
      chart.resize();
      setIsWide(container.clientWidth >= MINIMUM_DIRECT_LABEL_CHART_WIDTH);
    });
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const hasLegend = series.length >= 2;
    const hasDirectLabels = isWide && hasLegend && series.length <= MAXIMUM_DIRECT_LABELS;
    const times = result.times.map((time) => Date.parse(time));
    chart.setOption({
      animation: false,
      textStyle: { fontFamily: theme.fontFamily },
      grid: {
        left: 8,
        right: hasDirectLabels ? 96 : 16,
        top: hasLegend ? 40 : 16,
        bottom: 8,
        containLabel: true,
      },
      legend: hasLegend
        ? {
          type: "scroll",
          top: 0,
          left: 0,
          icon: "roundRect",
          itemWidth: 12,
          itemGap: 16,
          itemHeight: 4,
          textStyle: { color: theme.mutedText, width: LEGEND_LABEL_WIDTH, overflow: "truncate" },
          pageTextStyle: { color: theme.mutedText },
        }
        : { show: false },
      tooltip: {
        trigger: "axis",
        confine: true,
        backgroundColor: theme.surface,
        borderColor: theme.border,
        textStyle: { color: theme.text },
        axisPointer: { type: "line", lineStyle: { color: theme.mutedText } },
        valueFormatter: (value: unknown) =>
          formatMetricValue(typeof value === "number" ? value : null, unitLabel),
      },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: theme.border } },
        axisLabel: { color: theme.mutedText, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: false,
        axisLabel: {
          color: theme.mutedText,
          formatter: (value: number) => formatMetricValue(value, unitLabel),
        },
        splitLine: { lineStyle: { color: theme.gridLine } },
      },
      series: series.map((chartSeries) => ({
        name: chartSeries.label,
        type: "line",
        showSymbol: false,
        symbolSize: 8,
        // Exporters send every 60 seconds by default, so a step may miss its point; the line
        // bridges it rather than looking broken.
        connectNulls: true,
        lineStyle: { width: 2 },
        color: theme.seriesColors[chartSeries.colorSlot],
        emphasis: { focus: "series" },
        endLabel: hasDirectLabels
          ? {
            show: true,
            color: theme.mutedText,
            formatter: chartSeries.label,
            width: 88,
            overflow: "truncate",
          }
          : undefined,
        data: chartSeries.values.map((value, timeIndex) => [times[timeIndex], value]),
      })),
    }, { notMerge: true });
  }, [result, series, unitLabel, theme, isWide]);

  return (
    <div
      ref={containerRef}
      className="metric-chart"
      role="img"
      aria-label={description}
      data-series-count={series.length}
    />
  );
}

export function formatChartTime(time: string): string {
  return timeFormat.format(new Date(time));
}
