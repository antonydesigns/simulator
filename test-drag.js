import { chromium } from 'playwright';

const URL = 'http://localhost:8080';

async function testDrag() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // Get SVG bounding box and initial bus position
  const svgBox = await page.$eval('svg', el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });

  const initialPos = await page.$eval('#loadGroup circle', el => ({
    cx: parseFloat(el.getAttribute('cx')),
    cy: parseFloat(el.getAttribute('cy')),
  }));

  console.log('SVG element box:', svgBox);
  console.log('Initial bus position (SVG coords):', initialPos);

  // Find the load bus circle center in screen coords
  const loadBox = await page.$eval('#loadGroup circle', el => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log('Load bus screen center:', loadBox);

  // Perform a drag: 150px right, 50px down
  const dragDelta = { dx: 150, dy: 50 };
  await page.mouse.move(loadBox.x, loadBox.y);
  await page.mouse.down();
  // Move in small steps for realism
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      loadBox.x + (dragDelta.dx * i) / steps,
      loadBox.y + (dragDelta.dy * i) / steps,
      { steps: 3 }
    );
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(100);

  // Get new bus position
  const newPos = await page.$eval('#loadGroup circle', el => ({
    cx: parseFloat(el.getAttribute('cx')),
    cy: parseFloat(el.getAttribute('cy')),
  }));
  console.log('New bus position (SVG coords):', newPos);

  const actualDelta = { dx: newPos.cx - initialPos.cx, dy: newPos.cy - initialPos.cy };
  console.log('Actual SVG delta:', actualDelta);

  // Compute expected delta: screen delta mapped to SVG coords
  // Account for SVG content area (preserveAspectRatio)
  const aspect = 800 / 500; // viewBox aspect
  const elemAspect = svgBox.width / svgBox.height;
  let cw, ch;
  if (elemAspect > aspect) {
    ch = svgBox.height;
    cw = ch * aspect;
  } else {
    cw = svgBox.width;
    ch = cw / aspect;
  }
  const scaleFactor = 800 / cw; // SVG units per screen pixel (at zoom=1)
  const expectedDelta = {
    dx: dragDelta.dx * scaleFactor,
    dy: dragDelta.dy * scaleFactor,
  };
  console.log('Expected SVG delta:', expectedDelta);

  const error = {
    dx: Math.abs(actualDelta.dx - expectedDelta.dx),
    dy: Math.abs(actualDelta.dy - expectedDelta.dy),
  };
  console.log('Error (SVG units):', error);
  console.log('Error (pixels at current scale):', {
    dx: error.dx / scaleFactor,
    dy: error.dy / scaleFactor,
  });

  const pass = error.dx < 5 && error.dy < 5;
  console.log(pass ? '✅ PASS: Drag is 1:1' : '❌ FAIL: Drag is off');

  await browser.close();
  process.exit(pass ? 0 : 1);
}

testDrag().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
