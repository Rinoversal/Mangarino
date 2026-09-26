"""Unit tests for panelize.py's box logic. No models needed.

Run with the panelizer's Python:
    tools/panelizer/.venv/Scripts/python.exe -m unittest discover -s tools/panelizer -p "test_*.py"
"""
from __future__ import annotations

import unittest

from PIL import Image, ImageDraw

import panelize as pz

W, H = 1000, 1500  # page size for the box-growth tests


def letters(d: ImageDraw.ImageDraw, x1: int, y1: int, x2: int, y2: int, fill=0) -> None:
    """Rows of small blocks standing in for lettering, with paper showing between them."""
    for y in range(y1, y2 - 9, 16):
        for x in range(x1, x2 - 7, 12):
            d.rectangle([x, y, x + 7, y + 9], fill=fill)


def page(size=(600, 400)) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    im = Image.new("RGB", size, "white")
    return im, ImageDraw.Draw(im)


def near(testcase: unittest.TestCase, box, expected, tol=4) -> None:
    testcase.assertIsNotNone(box)
    for got, want in zip(box, expected):
        testcase.assertLessEqual(abs(got - want), tol, f"{box} vs {expected}")


class AttachBoxesTest(unittest.TestCase):
    def test_spilling_box_grows_its_panel_with_pad(self):
        out = pz.attach_boxes([[100, 100, 500, 600]], [([450, 200, 560, 300], 0.005)], W, H)
        self.assertEqual(out, [[100, 100, 565.0, 600]])

    def test_box_inside_panel_changes_nothing(self):
        out = pz.attach_boxes([[100, 100, 500, 600]], [([200, 200, 300, 300], 0.02)], W, H)
        self.assertEqual(out, [[100, 100, 500, 600]])

    def test_box_outside_every_panel_changes_nothing(self):
        out = pz.attach_boxes([[100, 100, 500, 600]], [([700, 700, 800, 800], 0.02)], W, H)
        self.assertEqual(out, [[100, 100, 500, 600]])

    def test_straddling_box_goes_to_the_panel_holding_most_of_it(self):
        a, b = [0, 0, 480, 500], [520, 0, 1000, 500]
        out = pz.attach_boxes([a, b], [([440, 100, 620, 200], 0.0)], W, H)
        self.assertEqual(out[0], a)  # 40 px of it in A
        self.assertEqual(out[1], [440, 0, 1000, 500])  # 100 px of it in B

    def test_balloon_across_a_gutter_is_whole_in_both_panels_side_by_side(self):
        a, b = [0, 0, 480, 500], [520, 0, 1000, 500]
        out = pz.attach_boxes([a, b], [([400, 100, 640, 200], 0.0)], W, H)
        self.assertEqual(out[0], [0, 0, 640, 500])  # 80 px (a third) of it in A
        self.assertEqual(out[1], [400, 0, 1000, 500])  # 120 px in B

    def test_balloon_across_a_gutter_between_stacked_panels_is_whole_in_both(self):
        top, bottom = [0, 0, 1000, 480], [0, 520, 1000, 1000]
        out = pz.attach_boxes([top, bottom], [([300, 400, 500, 640], 0.0)], W, H)
        self.assertEqual(out[0], [0, 0, 1000, 640])  # 80 px (a third) of it in the top panel
        self.assertEqual(out[1], [0, 400, 1000, 1000])  # 120 px in the bottom one

    def test_a_panel_holding_the_lettering_grows_even_with_little_of_the_balloon(self):
        a, b = [0, 0, 480, 500], [520, 0, 1000, 500]
        # a big balloon mostly in B (80%), its lettering near the gutter, half in A
        out = pz.attach_boxes([a, b], [([400, 100, 1000, 200], 0.0, [420, 120, 540, 180])], W, H)
        self.assertEqual(out[0], [0, 0, 1000, 500])
        self.assertEqual(out[1], [400, 0, 1000, 500])

    def test_lettering_sticking_out_of_a_balloon_is_taken_in(self):
        items = pz.with_lettering([([100, 100, 300, 250], 0.005)], [[150, 150, 350, 200], [600, 600, 700, 700]])
        self.assertEqual(items, [([100, 100, 350, 250], 0.005, [150, 150, 350, 200])])

    def test_growth_is_clamped_to_the_page(self):
        out = pz.attach_boxes([[600, 100, 990, 600]], [([900, 200, 1000, 300], 0.02)], W, H)
        self.assertEqual(out[0][2], float(W))


class FindContainerTest(unittest.TestCase):
    def container(self, im: Image.Image, text_box):
        labels, stats = pz.light_components(im)
        return pz.find_container(labels, stats, text_box)

    def test_square_caption_box(self):
        im, d = page()
        d.rectangle([100, 100, 300, 220], outline=0, width=3)
        letters(d, 130, 135, 270, 185)
        near(self, self.container(im, [128, 133, 272, 187]), [103, 103, 298, 218])

    def test_round_balloon(self):
        im, d = page()
        d.ellipse([100, 60, 420, 340], outline=0, width=3)
        letters(d, 200, 160, 320, 240)
        box = self.container(im, [198, 158, 322, 242])
        near(self, box, [103, 63, 418, 338], tol=6)

    def test_jagged_shout_balloon(self):
        im, d = page()
        pts = [(260, 40), (300, 110), (390, 80), (350, 170), (450, 200), (350, 240), (380, 330),
               (290, 280), (240, 360), (220, 280), (120, 320), (170, 230), (80, 190), (170, 150),
               (140, 70), (220, 120)]
        d.line(pts + [pts[0]], fill=0, width=3)
        letters(d, 195, 150, 325, 245)
        box = self.container(im, [193, 148, 327, 247])
        self.assertIsNotNone(box)
        self.assertLessEqual(box[0], 193)  # encloses the lettering...
        self.assertGreaterEqual(box[2], 327)
        self.assertGreaterEqual(box[0], 78)  # ...and stays inside the outline's bounds
        self.assertLessEqual(box[2], 452)

    def test_text_on_open_paper_has_no_container(self):
        im, d = page()
        letters(d, 200, 150, 320, 220)
        self.assertIsNone(self.container(im, [198, 148, 322, 222]))

    def test_light_text_on_dark_box_has_no_container(self):
        im, d = page()
        d.rectangle([100, 100, 330, 240], fill=0)
        letters(d, 130, 130, 300, 210, fill=255)
        self.assertIsNone(self.container(im, [128, 128, 302, 212]))

    def test_container_much_bigger_than_lettering_is_rejected(self):
        im, d = page()
        d.rectangle([20, 20, 580, 380], outline=0, width=3)  # a whole-panel frame, not a balloon
        letters(d, 280, 190, 310, 205)
        self.assertIsNone(self.container(im, [278, 188, 312, 207]))


class GrowthItemsTest(unittest.TestCase):
    def test_lettering_inside_a_detected_balloon_is_not_searched(self):
        im, _ = page()
        items = pz.growth_items([], [("bubble", [100, 100, 300, 250]), ("text_bubble", [150, 150, 250, 200])], im, 1.0, 1.0)
        self.assertEqual(items, [([100, 100, 300, 250], pz.BUBBLE_PAD_FRAC, [150, 150, 250, 200])])

    def test_uncovered_lettering_uses_its_container(self):
        im, d = page()
        d.rectangle([100, 100, 300, 220], outline=0, width=3)
        letters(d, 130, 135, 270, 185)
        items = pz.growth_items([[128, 133, 272, 187]], [], im, 1.0, 1.0)
        self.assertEqual(len(items), 1)
        near(self, items[0][0], [103, 103, 298, 218])
        self.assertEqual(items[0][1], pz.BUBBLE_PAD_FRAC)

    def test_uncovered_lettering_without_container_falls_back_to_padding(self):
        im, d = page()
        letters(d, 200, 150, 320, 220)
        items = pz.growth_items([[198, 148, 322, 222]], [], im, 1.0, 1.0)
        self.assertEqual(items, [([198, 148, 322, 222], pz.TEXT_PAD_FRAC, [198, 148, 322, 222])])

    def test_bare_loose_text_is_skipped_but_boxed_loose_text_counts(self):
        im, d = page()
        letters(d, 400, 300, 480, 340)  # bare: could be a sound effect
        d.rectangle([100, 100, 300, 220], outline=0, width=3)
        letters(d, 130, 135, 270, 185)  # inside a caption box
        items = pz.growth_items([], [("text_free", [398, 298, 482, 342]), ("text_free", [128, 133, 272, 187])], im, 1.0, 1.0)
        self.assertEqual(len(items), 1)
        near(self, items[0][0], [103, 103, 298, 218])

    def test_boxes_are_scaled_from_image_to_page_pixels(self):
        im, _ = page()
        items = pz.growth_items([], [("bubble", [10, 20, 30, 40])], im, 2.0, 3.0)
        self.assertEqual(items[0][0], [20, 60, 60, 120])


class DropBoxesTest(unittest.TestCase):
    def test_a_box_around_two_panels_is_dropped(self):
        a, b, around = [0, 0, 480, 500], [520, 0, 1000, 500], [0, 0, 1000, 500]
        self.assertEqual(pz.drop_phantoms([around, a, b]), [a, b])

    def test_a_big_panel_with_small_insets_stays(self):
        big, i1, i2 = [0, 0, 1000, 1000], [50, 50, 250, 250], [700, 700, 950, 950]
        self.assertEqual(pz.drop_phantoms([big, i1, i2]), [big, i1, i2])

    def test_a_panel_found_in_overlapping_pieces_stays(self):
        big, p1, p2 = [0, 0, 1000, 500], [0, 0, 600, 500], [400, 0, 1000, 500]
        self.assertEqual(pz.drop_phantoms([big, p1, p2]), [big, p1, p2])

    def test_a_panel_found_twice_keeps_the_bigger_box(self):
        outer, again, inset = [0, 0, 1000, 400], [0, 50, 1000, 350], [100, 100, 200, 200]
        self.assertEqual(pz.drop_duplicates([outer, again]), [outer])
        self.assertEqual(pz.drop_duplicates([outer, inset]), [outer, inset])


class PostprocessTest(unittest.TestCase):
    def test_reading_order_comes_from_the_frames_not_the_grown_boxes(self):
        im = Image.new("RGB", (W, H), "white")
        xyxy = [[0, 0, 480, 500], [520, 0, 1000, 500]]
        bubbles = [("bubble", [200, 100, 1000, 200])]  # most of it in the right panel, 35% in the left
        out = pz.postprocess(xyxy, [0, 0], W, H, 1.0, 1.0, True, bubbles=bubbles, image=im)
        # both grow to the right edge; right-to-left order still starts with the right panel
        self.assertEqual(out, [
            {"x": 195, "y": 0, "w": 805, "h": 500, "frame": [520, 0, 480, 500]},
            {"x": 0, "y": 0, "w": 1000, "h": 500, "frame": [0, 0, 480, 500]},
        ])

    def test_bubbles_off_keeps_lettering_padding(self):
        xyxy = [[0, 0, 480, 500], [520, 0, 1000, 500], [400, 100, 560, 200]]
        out = pz.postprocess(xyxy, [0, 0, 1], W, H, 1.0, 1.0, True)
        self.assertEqual(out[1], {"x": 0, "y": 0, "w": 580, "h": 500, "frame": [0, 0, 480, 500]})  # 560 + 2% of 1000

    def test_bubbles_on_grows_to_the_whole_balloon(self):
        im = Image.new("RGB", (W, H), "white")
        xyxy = [[0, 0, 480, 500], [520, 0, 1000, 500]]
        bubbles = [("bubble", [380, 80, 470, 560])]  # pokes out of the bottom of the left panel
        out = pz.postprocess(xyxy, [0, 0], W, H, 1.0, 1.0, True, bubbles=bubbles, image=im)
        left = next(p for p in out if p["x"] == 0)
        self.assertEqual(left["y"] + left["h"], 565)  # 560 + 0.5% of 1000


if __name__ == "__main__":
    unittest.main()
