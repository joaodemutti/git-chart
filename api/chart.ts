import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const canvas = new ChartJSNodeCanvas({
  width: 800,
  height: 400,
  backgroundColour: 'white'
});

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  const labels = (req.query.labels as string || 'A,B,C').split(',');
  const values = (req.query.values as string || '5,10,7')
    .split(',')
    .map(Number);

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Data',
          data: values
        }
      ]
    },
    options: {
      animation: false,
      responsive: false
    }
  };

  const image = await canvas.renderToBuffer(config as any);

  res.setHeader('Content-Type', 'image/png');
  res.end(image);
}