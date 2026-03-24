import { useMemo } from 'react';
import { Group } from '@visx/group';
import { LinePath } from '@visx/shape';
import { scaleTime, scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { curveMonotoneX } from '@visx/curve';
import { ParentSize } from '@visx/responsive';

export interface MultiLineDataPoint {
  date: Date | string;
  values: Record<string, number>;
}

export interface LineSeries {
  key: string;
  color: string;
  dashed?: boolean;
  label: string;
}

interface MultiLineChartProps {
  data: MultiLineDataPoint[];
  series: LineSeries[];
  width?: number;
  height?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  showGrid?: boolean;
  showLegend?: boolean;
}

const defaultMargin = { top: 20, right: 20, bottom: 40, left: 50 };

function MultiLineChartInner({
  data,
  series,
  width,
  height,
  margin = defaultMargin,
  showGrid = true,
  showLegend = true,
}: MultiLineChartProps & { width: number; height: number }) {
  const legendHeight = showLegend ? 32 : 0;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom - legendHeight;

  const parsedData = useMemo(
    () =>
      data.map((d) => ({
        date: typeof d.date === 'string' ? new Date(d.date) : d.date,
        values: d.values,
      })),
    [data]
  );

  const xScale = useMemo(
    () =>
      scaleTime({
        domain: [
          Math.min(...parsedData.map((d) => d.date.getTime())),
          Math.max(...parsedData.map((d) => d.date.getTime())),
        ],
        range: [0, innerWidth],
      }),
    [parsedData, innerWidth]
  );

  const maxValue = useMemo(() => {
    let max = 0;
    for (const point of parsedData) {
      for (const s of series) {
        const val = point.values[s.key] || 0;
        if (val > max) max = val;
      }
    }
    return max;
  }, [parsedData, series]);

  const yScale = useMemo(
    () =>
      scaleLinear({
        domain: [0, maxValue * 1.1],
        range: [innerHeight, 0],
        nice: true,
      }),
    [maxValue, innerHeight]
  );

  if (width < 100 || height < 100) return null;

  return (
    <div>
      <svg width={width} height={height - legendHeight}>
        <Group left={margin.left} top={margin.top}>
          {showGrid && (
            <GridRows
              scale={yScale}
              width={innerWidth}
              stroke="hsl(var(--border))"
              strokeOpacity={0.5}
            />
          )}

          {series.map((s) => (
            <LinePath
              key={s.key}
              data={parsedData}
              x={(d) => xScale(d.date)}
              y={(d) => yScale(d.values[s.key] || 0)}
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '5,5' : undefined}
              curve={curveMonotoneX}
            />
          ))}

          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={5}
            stroke="hsl(var(--border))"
            tickStroke="hsl(var(--border))"
            tickLabelProps={() => ({
              fill: 'hsl(var(--muted-foreground))',
              fontSize: 11,
              textAnchor: 'middle',
            })}
            tickFormat={(date) => {
              const d = date as Date;
              return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
            }}
          />
          <AxisLeft
            scale={yScale}
            numTicks={5}
            stroke="hsl(var(--border))"
            tickStroke="hsl(var(--border))"
            tickLabelProps={() => ({
              fill: 'hsl(var(--muted-foreground))',
              fontSize: 11,
              textAnchor: 'end',
              dy: '0.33em',
              dx: -4,
            })}
          />
        </Group>
      </svg>

      {showLegend && (
        <div className="flex items-center justify-center gap-6 pt-2">
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <div
                className="h-0.5 w-5"
                style={{
                  backgroundColor: s.color,
                  borderStyle: s.dashed ? 'dashed' : 'solid',
                  borderWidth: s.dashed ? '0 0 2px 0' : 0,
                  borderColor: s.color,
                  height: s.dashed ? 0 : 2,
                }}
              />
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MultiLineChart(
  props: Omit<MultiLineChartProps, 'width' | 'height'> & { height?: number }
) {
  const { height = 300, ...rest } = props;
  return (
    <ParentSize>
      {({ width }) => <MultiLineChartInner {...rest} width={width} height={height} />}
    </ParentSize>
  );
}
