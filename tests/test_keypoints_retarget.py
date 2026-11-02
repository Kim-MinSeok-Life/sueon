"""키포인트 파서·리타기팅 단위 테스트 (python -m unittest tests/test_keypoints_retarget.py)

AI-Hub 원본 ZIP 없이 실행되도록 합성 데이터와 avatar.vrm만 사용한다.
수학/파싱 검사이며 한국수어 정확성 검사가 아니다.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import aihub_keypoints as ak  # noqa: E402
import retarget_vrm as rv  # noqa: E402


def rand_rot(rng):
    q = rng.normal(size=4)
    return rv.matrix_from_quat(q / np.linalg.norm(q))


class NameParsing(unittest.TestCase):
    def test_keypoint_name_any_folder(self):
        for path in ('[라벨]02_real_word_keypoint/NIA_SL_WORD0001_REAL02_F_000000000184_keypoints.json',
                     '02/NIA_SL_WORD0001_REAL02_F/NIA_SL_WORD0001_REAL02_F_000000000184_keypoints.json',
                     r'C:\x\NIA_SL_WORD0001_REAL02_F_000000000184_keypoints.json'):
            k = ak.parse_name(path)
            self.assertEqual((k.item, k.actor_type + k.actor, k.cam, k.frame), ('WORD0001', 'REAL02', 'F', 184))
            self.assertEqual(k.take, 'NIA_SL_WORD0001_REAL02_F')

    def test_sentence_and_morpheme(self):
        k = ak.parse_name('NIA_SL_SEN0123_REAL11_D_000000000003_keypoints.json')
        self.assertEqual((k.kind, k.num, k.actor, k.cam), ('SEN', '0123', '11', 'D'))
        m = ak.parse_name('NIA_SL_WORD1502_REAL16_F_morpheme.json')
        self.assertEqual((m.suffix, m.frame), ('morpheme', None))

    def test_rejects_malformed(self):
        self.assertIsNone(ak.parse_name('NIA_SL_WORD1502_REAL16_F_keypoints.json'))  # 프레임 번호 없음
        self.assertIsNone(ak.parse_name('NIA_SL_WORD1502_REAL16_X_000000000001_keypoints.json'))
        self.assertIsNone(ak.parse_name('readme.json'))


def frame(scale=1.0, people_list=False):
    pose = []
    for j in range(25):
        pose += [0.01 * j * scale, -0.2 * scale, 2.35 * scale, 1]
    hand = [v for j in range(21) for v in (0.1 * scale, 0.2 * scale, 2.3 * scale, 1)]
    p = {'pose_keypoints_3d': pose, 'hand_left_keypoints_3d': hand, 'hand_right_keypoints_3d': hand,
         'face_keypoints_3d': [1.0] * 280, 'pose_keypoints_2d': [1.0] * 75, 'hand_left_keypoints_2d': [1.0] * 63,
         'hand_right_keypoints_2d': [1.0] * 63, 'face_keypoints_2d': [1.0] * 210}
    return {'version': 1.3, 'people': [p] if people_list else p, 'camparam': {'CameraMatrix': {'data': '1 0 0 0'}}}


class FrameChecks(unittest.TestCase):
    def test_people_object_or_list(self):
        self.assertEqual(ak.check_frame(frame()), [])
        self.assertEqual(ak.check_frame(frame(people_list=True)), [])

    def test_bad_lengths_and_missing(self):
        f = frame()
        f['people']['hand_left_keypoints_3d'] = f['people']['hand_left_keypoints_3d'][:80]
        f['people']['pose_keypoints_3d'][0:3] = [0, 0, 0]
        probs = ak.check_frame(f)
        self.assertTrue(any('hand_left_keypoints_3d: 길이' in p for p in probs))
        self.assertTrue(any('결측' in p for p in probs))

    def test_unit_detection(self):
        self.assertEqual(ak.unit_scale(frame()['people']), ('m', 1.0))
        self.assertEqual(ak.unit_scale(frame(1000.0)['people']), ('mm', 0.001))


class MorphemeAlignment(unittest.TestCase):
    def test_same_word_other_actor_not_aligned(self):
        kp = ak.parse_name('NIA_SL_WORD1502_REAL02_F_000000000000_keypoints.json')
        res = ak.morpheme_alignment(kp, ROOT / 'data/morphemes/NIA_SL_WORD1502_REAL16_F_morpheme.json', 105)
        self.assertFalse(res['aligned'])
        self.assertEqual(res['mismatch_fields'], ['actor'])
        self.assertEqual(res['labels'], ['골키퍼'])

    def test_exact_take_aligned(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'NIA_SL_WORD0001_REAL02_F_morpheme.json'
            p.write_text(json.dumps({'metaData': {'duration': 6.1}, 'data': [{'start': 1, 'end': 2, 'attributes': [{'name': 'x'}]}]}),
                         encoding='utf-8')
            kp = ak.parse_name('NIA_SL_WORD0001_REAL02_F_000000000000_keypoints.json')
            self.assertTrue(ak.morpheme_alignment(kp, p, 185)['aligned'])


class RotationMath(unittest.TestCase):
    def test_align_recovers_rotation(self):
        rng = np.random.default_rng(0)
        for _ in range(50):
            r = rand_rot(rng)
            d0, s0 = rng.normal(size=3), rng.normal(size=3)
            got = rv.align(d0, s0, r @ d0, r @ s0)
            self.assertTrue(np.allclose(got, r, atol=1e-9))

    def test_quat_roundtrip(self):
        rng = np.random.default_rng(1)
        for _ in range(50):
            r = rand_rot(rng)
            self.assertTrue(np.allclose(rv.matrix_from_quat(rv.quat_from_matrix(r)), r, atol=1e-9))

    def test_axis_conversion_is_rotation_not_mirror(self):
        m = np.diag([1.0, -1.0, -1.0])
        self.assertAlmostEqual(np.linalg.det(m), 1.0)
        # 촬영자 왼쪽 어깨(영상 오른쪽 +x) → 아바타 왼쪽(+X)
        self.assertGreater(rv.to_avatar_axes([0.17, -0.2, 2.35])[0], 0)


class RetargetRoundTrip(unittest.TestCase):
    """아바타 자신의 T-포즈를 회전시켜 만든 가짜 키포인트를 넣으면 같은 방향이 복원되어야 한다."""

    @classmethod
    def setUpClass(cls):
        cls.rest = rv.load_rest()

    def test_rest_has_tips(self):
        for side in ('left', 'right'):
            for f in rv.FINGERS:
                self.assertIn(f'{side}{f}Distal_tip', self.rest)

    def test_fk_matches_source_directions(self):
        rng = np.random.default_rng(2)
        rt = rv.Retargeter(self.rest, chest_weight=1.0)
        body = np.zeros((9, 3))
        body[rv.B_NECK] = [0, 0, 0]
        body[rv.B_MIDHIP] = [0, -0.5, 0]
        body[rv.B_LSHO], body[rv.B_RSHO] = [0.15, 0, 0], [-0.15, 0, 0]
        body[rv.B_LELB], body[rv.B_RELB] = [0.2, -0.25, 0.05], [-0.18, -0.2, 0.12]
        hands = {}
        for side, elb in (('left', rv.B_LELB), ('right', rv.B_RELB)):
            r = rand_rot(rng)
            h = np.zeros((21, 3))
            names = {0: f'{side}Hand'}
            for f, ids in rv.FINGERS.items():
                segs = rv.SEGMENTS.get(f, rv.DEFAULT_SEGMENTS)
                for k, j in enumerate(ids[:-1]):
                    names[j] = f'{side}{f}{segs[k]}'
                names[ids[-1]] = f'{side}{f}{segs[-1]}_tip'
            for j, n in names.items():
                h[j] = r @ (self.rest[n] - self.rest[f'{side}Hand'])
            h += body[elb] + rng.normal(scale=0.01, size=3) + np.array([0, -0.22, 0.1])
            hands[side] = h
        local, _ = rt.frame(body, hands, body[rv.B_LSHO] - body[rv.B_RSHO])
        fk = rv.fk_world_dirs(local, self.rest)
        src = rv.source_dirs(body, hands['left'], hands['right'])
        worst = max(rv.angle_deg(fk[k], src[k]) for k in src)
        self.assertLess(worst, 1e-4)

    def test_ik_reaches_wrist_target_and_keeps_hand(self):
        body, left, right = (np.array(v, dtype=float) for v in ([[0, 0.12, 0.08], [0, 0, 0], [-0.15, 0, 0], [-0.2, -0.25, 0.1],
                                                                 [0, 0, 0], [0.15, 0, 0], [0.18, -0.22, 0.15], [0, 0, 0], [0, -0.5, 0]],
                                                                np.zeros((21, 3)), np.zeros((21, 3))))
        rng = np.random.default_rng(3)
        for h, elb in ((left, rv.B_LELB), (right, rv.B_RELB)):
            h[:] = body[elb] + np.array([0, 0.12, 0.15]) + rng.normal(scale=0.03, size=(21, 3))
        origin = (body[rv.B_LSHO] + body[rv.B_RSHO]) / 2
        scale = float(np.linalg.norm(self.rest['leftUpperArm'] - self.rest['rightUpperArm'])) / 0.3
        rt = rv.Retargeter(self.rest, chest_weight=0.0, ik_origin=origin, ik_scale=scale)
        local, _ = rt.frame(body, {'left': left, 'right': right}, body[rv.B_LSHO] - body[rv.B_RSHO])
        stats = {'signer_origin': origin, 'avatar_scale': scale}
        fk = rv.fk_world_dirs(local, self.rest)
        src = rv.source_dirs(body, left, right)
        for side, h in (('left', left), ('right', right)):
            err = np.linalg.norm(rv.fk_wrist(local, self.rest, side) - rv.rest_target(self.rest, stats, h[0]))
            self.assertLess(err, 1e-6)
            # 손 방향·손바닥·손가락은 IK와 무관하게 원본과 일치
            for k in (f'{side}Hand', f'{side}PalmNormal', f'{side}IndexIntermediate', f'{side}ThumbDistal'):
                self.assertLess(rv.angle_deg(fk[k], src[k]), 1e-4)


class BodyClearance(unittest.TestCase):
    """아바타 몸 앞면 격자와 손·아래팔 관통 방지"""

    def test_body_front_profile(self):
        bf = rv.BodyFront()
        self.assertAlmostEqual(bf.front(0.0, 1.0), 0.1286, places=3)  # 가슴 중앙 셔츠 앞면
        self.assertEqual(bf.front(0.4, 1.0), -np.inf)  # 몸 바깥
        self.assertEqual(bf.front(0.0, 0.5), -np.inf)  # 측정 범위 밖(다리)

    def test_no_penetration_after_retarget(self):
        path = ROOT / 'data/keypoints/word1502_real02_F.json'
        if not path.exists():
            self.skipTest('AI-Hub 발췌 키포인트 없음(재배포 금지 파일)')
        kp = json.loads(path.read_text(encoding='utf-8'))
        rest, bf = rv.load_rest(), rv.BodyFront()
        frames, _, stats = rv.retarget(kp, rest, body_front=bf)
        self.assertGreater(max(stats['penetration_before_cm'].values()), 5)  # 보정 전에는 실제로 관통
        for side in ('left', 'right'):
            worst = max(rv.penetration(rv.arm_points(f['local'], f['world'], rest, side), bf) for f in frames)
            self.assertLess(worst, 0.002)
            # 사용자 요청: 손은 기본 3cm 이상 앞으로(얼굴에 닿는 손은 예외: 머리 가까울수록 덜 뺌)
            self.assertTrue(all(f['forward'][side][2] >= 0.03 * (1 - f['head_weight'][side]) - 1e-9 for f in frames))


class HeadProportion(unittest.TestCase):
    """머리가 큰 아바타: 얼굴 근처 손은 머리 비율로 다시 맞춘다(귀를 가리키면 볼이 아니라 귀 옆)"""

    @classmethod
    def setUpClass(cls):
        cls.rest, cls.bf = rv.load_rest(), rv.BodyFront()

    def signer(self, n=5):
        # 촬영자 몸통 좌표(m): 어깨폭 0.32, 귀 반폭 0.08, 코는 귀보다 8cm 앞·눈보다 3.4cm 아래
        body = np.zeros((n, 15, 3))
        body[:, rv.B_RSHO], body[:, rv.B_LSHO] = [-0.16, 0, 0], [0.16, 0, 0]
        body[:, rv.B_MIDHIP] = [0, -0.5, 0]
        body[:, rv.B_REYE], body[:, rv.B_LEYE] = [-0.03, 0.2, 0.07], [0.03, 0.2, 0.07]
        body[:, rv.B_REAR], body[:, rv.B_LEAR] = [-0.08, 0.186, 0.0], [0.08, 0.186, 0.0]
        body[:, rv.B_NOSE] = [0, 0.166, 0.08]
        return body

    def test_head_front_includes_face(self):
        self.assertGreater(self.bf.front(0.0, 1.40), 0.07)  # 코끝
        self.assertGreater(self.bf.front(0.0, 1.52), 0.06)  # 이마(앞머리)

    def test_hand_at_ear_maps_to_avatar_ear(self):
        body = self.signer()
        hand = np.repeat(np.array([[-0.09, 0.186, 0.0]]), 5, 0)[:, None].repeat(21, 1)  # 오른쪽 귀 바로 옆
        origin = np.zeros(3)
        scale = float(np.linalg.norm(self.rest['leftUpperArm'] - self.rest['rightUpperArm'])) / 0.32
        off, w, k = rv.head_offsets(body, {'right': hand}, self.rest, self.bf.head, origin, scale)
        av_origin = (self.rest['leftUpperArm'] + self.rest['rightUpperArm']) / 2
        body_only = av_origin + hand[0, 0] * scale
        mapped = body_only + off['right'][2]
        self.assertAlmostEqual(w['right'][2], 1.0)
        self.assertLess(body_only[0], -0.05)       # 몸 비율만 쓰면 볼(얼굴 안쪽)
        self.assertLess(mapped[0], -0.105)          # 보정 후 아바타 귀(반폭 0.10) 바깥
        self.assertAlmostEqual(mapped[1], self.bf.head["eye_y"] - 0.014 * k[1], places=3)
        self.assertAlmostEqual(k[1], k[0])  # 높이 배율 = 머리 폭 배율

    def test_chest_hand_unchanged(self):
        body = self.signer()
        hand = np.repeat(np.array([[0.0, -0.2, 0.15]]), 5, 0)[:, None].repeat(21, 1)  # 가슴 앞
        off, w, _ = rv.head_offsets(body, {'left': hand}, self.rest, self.bf.head, np.zeros(3), 0.7)
        self.assertEqual(float(np.abs(off['left']).max()), 0.0)


class MorphemeTrim(unittest.TestCase):
    """같은 촬영본 형태소 구간으로 자르기 — 시간축이 어긋나면 쓰지 않는다"""

    kp = {'frames': [{'i': i} for i in range(105)]}  # 3.5초

    def test_uses_interval_with_padding(self):
        m = {'metaData': {'duration': 3.484}, 'data': [{'start': 1.646, 'end': 2.626}]}
        self.assertEqual(rv.morpheme_range(self.kp, m, 30.0), (43, 85))  # 49~79프레임 ± 6프레임

    def test_rejects_misaligned_duration(self):
        m = {'metaData': {'duration': 6.0}, 'data': [{'start': 1.0, 'end': 2.0}]}
        self.assertIsNone(rv.morpheme_range(self.kp, m, 30.0))

    def test_none_without_morpheme(self):
        self.assertIsNone(rv.morpheme_range(self.kp, None, 30.0))


class DepthFix(unittest.TestCase):
    def test_moves_hand_along_camera_ray(self):
        cam = np.array([0.0, 0.1, 2.3])  # 몸통 좌표에서 카메라는 정면(+Z) 쪽
        hand = np.array([[0.05, -0.2, -0.15]]) + np.random.default_rng(4).normal(scale=0.03, size=(21, 3))
        hand[0] = [0.05, -0.2, -0.15]
        before = hand.copy()
        self.assertTrue(rv.fix_hand_depth(hand, cam, 0.15, 0.5))
        self.assertAlmostEqual(hand[0, 2], 0.03, places=9)
        # 카메라에서 본 방향(=2D 투영) 유지, 손 내부 뼈 방향 유지
        for j in range(21):
            self.assertLess(rv.angle_deg(hand[j] - cam, before[j] - cam), 1e-4)
        self.assertLess(rv.angle_deg(hand[9] - hand[0], before[9] - before[0]), 1e-4)

    def test_leaves_plausible_hand(self):
        hand = np.zeros((21, 3)) + [0.05, -0.2, 0.2]
        self.assertFalse(rv.fix_hand_depth(hand, np.array([0, 0, 2.3]), 0.15, 0.5))


if __name__ == '__main__':
    unittest.main()
