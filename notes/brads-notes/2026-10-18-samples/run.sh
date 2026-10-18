#!/bin/zsh
# What fewer samples cost: the ten test poses, four views, three renders each
# at 96 and 150 samples, against the three 300-sample renders already made
# (stack-2g-test, -r2, -r3: every export took 300 before 2026-10-18, whatever
# their records say). All nine analysed by today's code, pooled carry as in
# 2026-10-05-repeat/pool.sh, and solved from the same 300-sample sweeps, so
# only the test frames' noise differs. Not the best analysis there is: on the
# same 300-sample renders it gives x 0.068-0.089 mm where design-lab-model.md
# §5's thirty-first gave 0.026-0.059. A comparison between counts, not a record.
# Results: tables.txt; write-up: §5, "A forty-second".
#   notes/brads-notes/2026-10-18-samples/run.sh            render, analyse, solve
#   SKIP_RENDER=1 notes/brads-notes/2026-10-18-samples/run.sh   analyse and solve again
#   LEDGE=1 SKIP_RENDER=1 ...   analyse with the ledge held, as the sweeps' own
#     records are (results/stack-2g-{x,y,z,turn}, 2026-10-07), into <name>-ledge.
# Without LEDGE the test frames are read without the ledge and calibrated from
# sweeps read with it: that mismatch, not the analysis's age, is why x came out
# 0.068-0.089 mm. Today's code reproduces both consistent pairings (0.025 with
# the ledge, the thirty-first's 0.026 without).
cd "$(dirname "$0")/../../.."
OUT=results/samples; mkdir -p $OUT
POOL=(--carry-from results/stack-2g-x/pairs --carry-from results/stack-2g-y/pairs --carry-from results/stack-2g-z/pairs --carry-from results/stack-2g-turn/pairs)
COMMON=(--scene saved:stack-2 --moving Cube2 --target Cube --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry $POOL)
SFX=; [[ -n $LEDGE ]] && { COMMON+=(--ledge results/ledge/stack-2g-ledge.json); SFX=-ledge; }
TEST="1.5,5,-1,0;-2,3,2,0;0.7,6,1.3,0;-1.2,4.5,-2.5,0;2.5,2.5,0.8,0;1,4,-1,1.5;-1.5,5,1.5,-2;0.5,3,-0.5,2.5;-0.8,6,2.2,-1;2,4.5,0,-3"
SWEEPS=(--x results/stack-2g-x/pairs --y results/stack-2g-y/pairs --z results/stack-2g-z/pairs --turn results/stack-2g-turn/pairs)

# The 300-sample renders, under this experiment's names, analysed without rendering.
i=1; for src in stack-2g-test stack-2g-test-r2 stack-2g-test-r3; do
  [[ -e generated/stack-2g-test-s300-r$i ]] || ln -s $src generated/stack-2g-test-s300-r$i
  i=$((i + 1))
done

tone() { node -e "console.log(JSON.stringify(require('./$1/pairs/gap-sweep.json').toneMapping))"; }

for S in 96 150 300; do
  for r in 1 2 3; do
    name=stack-2g-test-s$S-r$r$SFX
    [[ -n $SFX && ! -e generated/$name ]] && ln -s stack-2g-test-s$S-r$r generated/$name
    if [[ $S == 300 || -n $SKIP_RENDER ]]; then R=(--skip-render); else R=(--samples $S); fi
    t0=$SECONDS
    npm run -s gap-sweep -- --name $name $COMMON --poses "$TEST" $R --overwrite > $OUT/$name.log 2>&1 \
      && echo "done $name $((SECONDS - t0)) s" || { echo "FAIL $name (see $OUT/$name.log)"; exit 1; }
    # The first new render must be lit and exposed as the old ones were.
    if [[ $name == stack-2g-test-s96-r1$SFX && $(tone results/$name) != $(tone results/stack-2g-test) ]]; then
      echo "tone mapping differs: $(tone results/$name) against $(tone results/stack-2g-test)"; exit 1
    fi
    for c in hinged joint; do
      npm run -s position -- $SWEEPS --test results/$name/pairs --max-views 4 --calibrate $c --out $OUT/$name-$c.json > /dev/null \
        || { echo "FAIL solve $name $c"; exit 1; }
    done
  done
done

for c in hinged joint; do
  echo "\n== $c: test-pose error, x / y / z mm and turn deg"
  node notes/brads-notes/2026-10-06-aperture/summary.js $OUT/stack-2g-test-s{96,150,300}-r{1,2,3}$SFX-$c.json
done
for S in 96 150 300; do
  echo "\n== $S samples: bias and scatter over three renders (hinged)"
  node notes/brads-notes/2026-10-05-repeat/repeat.js results/stack-2g-test-s$S-r{1,2,3}$SFX/pairs -- $OUT/stack-2g-test-s$S-r{1,2,3}$SFX-hinged.json
done
