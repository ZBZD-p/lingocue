import unittest

import youtube


class YouTubeUrlTests(unittest.TestCase):
    def test_watch_url_uses_v_query_parameter(self):
        self.assertEqual(
            youtube._video_id_from_url("https://www.youtube.com/watch?v=watch_id"),
            "watch_id",
        )

    def test_shorts_url_uses_path_segment(self):
        for url in (
            "https://www.youtube.com/shorts/short_id",
            "https://www.youtube.com/shorts/short_id/",
            "https://www.youtube.com/shorts/short_id?feature=share",
        ):
            with self.subTest(url=url):
                self.assertEqual(youtube._video_id_from_url(url), "short_id")

    def test_non_video_url_has_no_id(self):
        self.assertEqual(youtube._video_id_from_url("https://www.youtube.com/"), "")


if __name__ == "__main__":
    unittest.main()
