import React from 'react';
import { renderToString } from 'react-dom/server';
import Marketplace from './src/pages/Marketplace';

try {
  const html = renderToString(<Marketplace />);
  console.log("Render successful, length:", html.length);
} catch (e) {
  console.error("Render failed:", e);
}
