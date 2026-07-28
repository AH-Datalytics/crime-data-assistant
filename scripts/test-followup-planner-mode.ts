import assert from 'node:assert/strict';
import { plannerModeForSource } from '../lib/followup-planner-mode';

delete process.env.FOLLOWUP_PLANNER_MODE;
assert.equal(plannerModeForSource('nibrs'), 'off');
process.env.FOLLOWUP_PLANNER_MODE = 'compare';
assert.equal(plannerModeForSource('nibrs'), 'compare');
assert.equal(plannerModeForSource('historical'), 'compare');
process.env.FOLLOWUP_PLANNER_MODE = 'authoritative';
process.env.FOLLOWUP_PLANNER_SOURCES = 'nibrs,historical';
assert.equal(plannerModeForSource('nibrs'), 'authoritative');
assert.equal(plannerModeForSource('historical'), 'authoritative');
assert.equal(plannerModeForSource('shr'), 'compare');
process.env.FOLLOWUP_PLANNER_MODE = 'bogus';
assert.equal(plannerModeForSource('nibrs'), 'off');
delete process.env.FOLLOWUP_PLANNER_MODE;
delete process.env.FOLLOWUP_PLANNER_SOURCES;
console.log('followup-planner-mode tests passed');
