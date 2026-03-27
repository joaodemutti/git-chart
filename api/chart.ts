import * as echarts from 'echarts';
import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  const labels = ((req.query.labels as string) || 'A,B,C').split(',');
  const values = ((req.query.values as string) || '5,10,7')
    .split(',')
    .map(Number);

  const chart = echarts.init(null, undefined, {
    renderer: 'svg',
    ssr: true,
    width: 800,
    height: 400
  });

  chart.setOption({
    animation: false,
    xAxis: {
      type: 'category',
      data: labels
    },
    yAxis: {
      type: 'value'
    },
    series: [
      {
        name: 'Data',
        type: 'bar',
        data: values
      }
    ]
  });

  const svg = chart.renderToSVGString();

  chart.dispose();

  res.setHeader('Content-Type', 'image/svg+xml');
  res.end(svg);
}