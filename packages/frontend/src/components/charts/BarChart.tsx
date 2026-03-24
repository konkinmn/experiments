import { useMemo } from 'react';
import { Group } from '@visx/group';
import { Bar } from '@visx/shape';
import { scaleBand, scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { ParentSize } from '@visx/responsive';

export interface BarDataPoint {
  label: string;
  value: number;
}

interface BarChartProps {
  data: BarDataPoint[];
  width?: number;
  height?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  color?: string;
  showGrid?: boolean;
}

const defaultMargin = { top: 20, right: 20, bottom: 50, left: 50 };

function BarChartInner({
  data,
  width,
  height,
  margin = defaultMargin,
  color = 'hsl(var(--chart-2))',
  showGrid = true,
}: BarChartProps & { width: number; height: number }) {
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const xScale = useMemo(
    () =>
      scaleBand<string>({
        domain: data.map((d) => d.label),
        range: [0, innerWidth],
        padding: 0.3,
      }),
    [data, innerWidth]
  );

  const yScale = useMemo(
    () =>
      scaleLinear({
        domain: [0, Math.max(...data.map((d) => d.value)) * 1.1],
        range: [innerHeight, 0],
        nice: true,
      }),
    [data, innerHeight]
  );

  if (width < 100 || height < 100) return null;

  return (
    <svg width={width} height={height}>
      <Group left={margin.left} top={margin.top}>
        {showGrid && (
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke="hsl(var(--border))"
            strokeOpacity={0.5}
          />
        )}
        {data.map((d) => {
          const barWidth = xScale.bandwidth();
          const barHeight = innerHeight - yScale(d.value);
          const barX = xScale(d.label) ?? 0;
          const barY = innerHeight - barHeight;

          return (
            <Bar
              key={d.label}
              x={barX}
              y={barY}
              width={barWidth}
              height={barHeight}
              fill={color}
              rx={4}
            />
          );
        })}
        <AxisBottom
          top={innerHeight}
          scale={xScale}
          stroke="hsl(var(--border))"
          tickStroke="hsl(var(--border))"
          tickLabelProps={() => ({
            fill: 'hsl(var(--muted-foreground))',
            fontSize: 11,
            textAnchor: 'middle',
            angle: -45,
            dy: 5,
          })}
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
  );
}

export function BarChart(props: Omit<BarChartProps, 'width' | 'height'> & { height?: number }) {
  const { height = 300, ...rest } = props;
  return (
    <ParentSize>
      {({ width }) => <BarChartInner {...rest} width={width} height={height} />}
    </ParentSize>
  );
}
