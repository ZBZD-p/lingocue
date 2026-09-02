import unittest

import youtube


class YouTubeUrlTests(unittest.TestCase):
    URL_CASES = (
        ("https://www.youtube.com/watch?v=watch_id", "watch_id"),
        ("https://www.youtube.com/watch?v=watch_id&feature=share", "watch_id"),
        ("https://www.youtube.com/shorts/short_id", "short_id"),
        ("https://www.youtube.com/shorts/short_id/", "short_id"),
        ("https://www.youtube.com/shorts/short_id?feature=share", "short_id"),
        ("https://youtu.be/short_id", ""),
        ("https://www.youtube.com/live/live_id", ""),
        ("https://www.youtube.com/", ""),
        ("https://www.youtube.com/@channel", ""),
        ("https://www.youtube.com/results?search_query=english", ""),
        ("https://www.youtube.com/results?search_query=x&v=abc123", ""),
    )

    def test_video_url_table(self):
        for url, expected in self.URL_CASES:
            with self.subTest(url=url):
                self.assertEqual(youtube._video_id_from_url(url), expected)


if __name__ == "__main__":
    unittest.main()
