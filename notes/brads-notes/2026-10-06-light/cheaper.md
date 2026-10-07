# A cheaper light search (2026-10-07)

Open item C of the second list. design-lab-model.md §5, the thirtieth's
"Cheaper, measured".

cheap.js: one frame per view (the turn sweep's reference pose) per light.
The two straight-but-wrong lights (60/5, 70/6) match the good ones on
gapSigma, strip level and ledge gain; only the truth error differs.

subset.sh / subset.js: each light's full runs, rows subset to the reference
+-2 mm on x, y, z and +-1.5 deg turn (nine positions), and test poses
1,4,7 (sub3) or 1,3,5,7,9 (sub5, TEST=... SUF=-sub5). Solved hinged.

    x mm, no truth     full 4v/sets    sub5 4v/sets    sub3 sets
    45/5               0.026/0.049     0.023/0.077     0.037
    45/10              0.026/0.068     0.148/0.160     0.094
    60/5               0.244/0.242     0.336/0.341     0.221
    70/6               0.325/0.346     0.416/0.351     0.136
    warned (4)         0.9-1.7/1.9-5.6 0.9-3.8/1.2-5.3 1.6-4.1

Same choice at 14 positions of 35. Margin runner-up to first bad: 3.5x full,
2.1x sub5, 1.4x sub3. Four views alone miss 60/5 with three test poses
(0.042): score over every set.
