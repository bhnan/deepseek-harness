// 图表封装（echarts 按需引入）：折线 / 柱状 / 饼图 / 雷达 / 散点 / 箱线 / 自定义
import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart, RadarChart, ScatterChart, BoxplotChart, CustomChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent, MarkLineComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([LineChart, BarChart, PieChart, RadarChart, ScatterChart, BoxplotChart, CustomChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, MarkLineComponent, CanvasRenderer]);

export default function Chart({ option, height = 260 }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); chart.dispose(); chartRef.current = null; };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} style={{ height, width: '100%' }} />;
}

// ---- 常用 option 构造器 ----
export function lineOption(x, series, { name = '', yName = '分数', colors } = {}) {
  return {
    tooltip: { trigger: 'axis' },
    legend: series.length > 1 ? { data: series.map((s) => s.name), top: 0 } : undefined,
    grid: { left: 48, right: 16, top: series.length > 1 ? 32 : 24, bottom: 28 },
    xAxis: { type: 'category', data: x },
    yAxis: { type: 'value', name: yName },
    series: series.map((s) => ({ name: s.name, type: 'line', smooth: true, data: s.data, connectNulls: true })),
  };
}

export function barOption(x, data, { name = '', yName = '', horizontal = false } = {}) {
  // 多系列分组柱状图：data 传 [{name, data:[...]}, ...]；单系列沿用旧签名
  const multi = Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && !Array.isArray(data[0]) && Array.isArray(data[0].data);
  const series = multi
    ? data.map((s) => ({ name: s.name, type: 'bar', data: s.data, barWidth: '55%' }))
    : [{ name, type: 'bar', data, barWidth: '55%' }];
  if (multi) {
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: series.map((s) => s.name), top: 0 },
      grid: { left: 48, right: 16, top: 34, bottom: 28 },
      xAxis: { type: 'category', data: x },
      yAxis: { type: 'value', name: yName },
      series,
    };
  }
  return horizontal
    ? {
        tooltip: { trigger: 'axis' },
        grid: { left: 90, right: 20, top: 20, bottom: 28 },
        xAxis: { type: 'value' },
        yAxis: { type: 'category', data: x },
        series: [{ name, type: 'bar', data, barWidth: '55%', label: { show: true, position: 'right' } }],
      }
    : {
        tooltip: { trigger: 'axis' },
        grid: { left: 48, right: 16, top: 20, bottom: 28 },
        xAxis: { type: 'category', data: x },
        yAxis: { type: 'value', name: yName },
        series: [{ name, type: 'bar', data, barWidth: '55%' }],
      };
}

export function scatterOption(series, { xName = '', yName = '', xFormatter } = {}) {
  // series: [{name, data: [[x, y, label], ...]}]
  return {
    tooltip: { trigger: 'item', formatter: (p) => {
      const d = p.data || [];
      const label = d[2] || '';
      return `${p.seriesName}${label ? '：' + label : ''}<br/>${xName}：${xFormatter ? xFormatter(d[0]) : d[0]}<br/>${yName}：${d[1]}`;
    } },
    grid: { left: 48, right: 24, top: series.length > 1 ? 32 : 20, bottom: 34 },
    xAxis: { type: 'value', name: xName, axisLabel: xFormatter ? { formatter: xFormatter } : undefined },
    yAxis: { type: 'value', name: yName, scale: true },
    legend: series.length > 1 ? { data: series.map((s) => s.name), top: 0 } : undefined,
    series: series.map((s) => ({ name: s.name, type: 'scatter', data: s.data, symbolSize: 11, itemStyle: { opacity: 0.75 } })),
  };
}

export function pieOption(data, { name = '' } = {}) {
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} 人 ({d}%)' },
    legend: { bottom: 0 },
    series: [{ name, type: 'pie', radius: ['38%', '62%'], data, label: { formatter: '{b}: {c}' } }],
  };
}

export function radarOption(indicator, series, { name = '' } = {}) {
  return {
    tooltip: {},
    legend: series.length > 1 ? { data: series.map((s) => s.name), bottom: 0 } : undefined,
    radar: { indicator, radius: '65%' },
    series: [{ type: 'radar', data: series.map((s) => ({ name: s.name, value: s.value, areaStyle: { opacity: 0.15 } })) }],
  };
}
