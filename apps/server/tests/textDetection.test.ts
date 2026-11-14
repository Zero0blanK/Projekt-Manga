import { describe, expect, it } from 'vitest';
import { placeText, type DetectedBox } from '../src/services/textDetection.service.js';

const box = (
  label: DetectedBox['label'],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  score = 0.9,
): DetectedBox => ({ label, score, x0, y0, x1, y1 });

describe('placing the text the detector found', () => {
  it("reads the text tightly and places it over its bubble's inner area", () => {
    const [placement] = placeText(
      [box('bubble', 100, 100, 300, 400), box('text_bubble', 180, 150, 220, 350)],
      1000,
      1500,
    );
    // Read: the text, a little padded.
    expect(placement.crop.x0).toBeLessThan(180);
    expect(placement.crop.x1).toBeGreaterThan(220);
    // Placed: wider than the text, inside the bubble.
    expect(placement.place.x0).toBeGreaterThan(100);
    expect(placement.place.x0).toBeLessThan(180);
    expect(placement.place.x1).toBeGreaterThan(220);
    expect(placement.place.x1).toBeLessThan(300);
  });

  it('gives each text its own spot in a bubble that holds several', () => {
    const placements = placeText(
      [
        box('bubble', 0, 0, 600, 600),
        box('text_bubble', 50, 50, 120, 300),
        box('text_free', 400, 50, 500, 400),
      ],
      1000,
      1000,
    );
    expect(placements).toHaveLength(2);
    for (const { place } of placements) expect(place.x1 - place.x0).toBeLessThan(200);
  });

  it('reads each text once, and leaves out unsure detections', () => {
    const placements = placeText(
      [
        box('text_free', 100, 100, 300, 300),
        box('text_bubble', 120, 120, 200, 200),
        box('text_free', 600, 600, 700, 700, 0.1),
      ],
      1000,
      1000,
    );
    expect(placements).toHaveLength(1);
  });

  it('keeps everything on the page', () => {
    const [placement] = placeText([box('text_free', -20, -20, 50, 2000)], 400, 1000);
    expect(placement.crop.x0).toBe(0);
    expect(placement.crop.y0).toBe(0);
    expect(placement.crop.y1).toBe(1000);
  });
});
