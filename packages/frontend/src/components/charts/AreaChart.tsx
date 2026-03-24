import { useMemo } from 'react';
import { Group } from '@visx/group';
import { AreaClosed, LinePath } from '@visx/shape';
import { scaleTime, scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { curveMonotoneX } from '@visx/curve';
import { LinearGradient } from '@visx/gradient';
import { ParentSize } from '@visx/responsive';

export interface AreaDataPoint {
  date: Date | string;
  value: number;
}

interface AreaChartProps {
  data: AreaDataPoint[];
  width?: number;
  height?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  color?: string;
  showGrid?: boolean;
  showDataPoints?: boolean;
  showYAxis?: boolean;
}

const defaultMargin = { top: 20, right: 20, bottom: 40, left: 20 };

function AreaChartInner({
  data,
  width,
  height,
  margin = defaultMargin,
  color = 'hsl(var(--chart-3))',
  showGrid = true,
  showDataPoints = true,
  showYAxis = false,
}: AreaChartProps & { width: number; height: number }) {
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const parsedData = useMemo(
    () =>
      data.map((d) => ({
        date: typeof d.date === 'string' ? new Date(d.date) : d.date,
        value: d.value,
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

  const yScale = useMemo(
    () =>
      scaleLinear({
        domain: [0, Math.max(...parsedData.map((d) => d.value)) * 1.1],
        range: [innerHeight, 0],
        nice: true,
      }),
    [parsedData, innerHeight]
  );

  if (width < 100 || height < 100) return null;

  const gradientId = `area-gradient-${Math.random().toString(36).substr(2, 9)}`;

  return (
    <svg width={width} height={height}>
      <LinearGradient id={gradientId} from={color} to={color} fromOpacity={0.4} toOpacity={0.05} />
      <Group left={margin.left} top={margin.top}>
        {showGrid && (
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke="hsl(var(--border))"
            strokeOpacity={0.5}
          />
        )}
        <AreaClosed
          data={parsedData}
          x={(d) => xScale(d.date)}
          y={(d) => yScale(d.value)}
          yScale={yScale}
          curve={curveMonotoneX}
          fill={`url(#${gradientId})`}
        />
        <LinePath
          data={parsedData}
          x={(d) => xScale(d.date)}
          y={(d) => yScale(d.value)}
          stroke={color}
          strokeWidth={2}
          curve={curveMonotoneX}
        />
        {showDataPoints &&
          parsedData.map((d, i) => (
            <circle
              key={i}
              cx={xScale(d.date)}
              cy={yScale(d.value)}
              r={5}
              fill="white"
              stroke={color}
              strokeWidth={2}
            />
          ))}
        <AxisBottom
          top={innerHeight}
          scale={xScale}
          numTicks={5}
          stroke="hsl(var(--border))"
          tickStroke="hsl(var(--border))"
          tickFormat={(date) => {
            const d = date as Date;
            return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
          }}
          tickLabelProps={() => ({
            fill: 'hsl(var(--muted-foreground))',
            fontSize: 11,
            textAnchor: 'middle',
          })}
        />
        {showYAxis && (
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
        )}
      </Group>
    </svg>
  );
}

export function AreaChart(props: Omit<AreaChartProps, 'width' | 'height'> & { height?: number }) {
  const { height = 300, ...rest } = props;
  return (
    <ParentSize>
      {({ width }) => <AreaChartInner {...rest} width={width} height={height} />}
    </ParentSize>
  );
}
