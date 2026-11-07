const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../web/core.js');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/patterns.js'), 'utf8'), context);
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/device-library.js'), 'utf8'), context);
const patterns = JSON.parse(JSON.stringify(context.window.LIFE_PATTERNS));
const profile = require('../publication-profile.json');
assert(['full', 'public'].includes(profile.profile));
const publicProfile = profile.profile === 'public';

// Independent unbounded scalar B3/S23 reference. Negative coordinates are
// intentional: a catalog spaceship must move without artificial edge loss.
function step(old) {
  const counts = new Map();
  for (const encoded of old) {
    const [x,y] = encoded.split(',').map(Number);
    for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
      if (!dx && !dy) continue;
      const key = `${x+dx},${y+dy}`;
      counts.set(key,(counts.get(key)||0)+1);
    }
  }
  return new Set([...counts].filter(([key,n]) => n===3 || n===2 && old.has(key)).map(([key])=>key));
}
const sorted = cells => [...cells].sort();
const same = (a,b) => a.size===b.size && [...a].every(key=>b.has(key));
function translate(cells,dx,dy) {
  return new Set([...cells].map(key => {const [x,y]=key.split(',').map(Number);return `${x+dx},${y+dy}`;}));
}
function within(cells,roi) {
  return new Set([...cells].filter(key=>{const [x,y]=key.split(',').map(Number);return x>=roi.x&&y>=roi.y&&x<roi.x+roi.width&&y<roi.y+roi.height;}));
}

test('catalog has the exact reviewed profile and exposes the same entries through the API',()=>{
  assert.equal(patterns.length,publicProfile ? 59 : 72);
  assert.equal(new Set(patterns.map(p=>p.id)).size,patterns.length);
  assert.deepEqual(patterns,JSON.parse(fs.readFileSync(path.join(__dirname,'../web/patterns.json'),'utf8')));
  for (const id of ['not-input-zero','not-input-one','and-latch','gosper','pulsar'])
    assert(patterns.some(p=>p.id===id),id);
  assert(patterns.filter(p=>p.type==='СТАБІЛЬНА ФІГУРА').length>=10);
  assert(patterns.filter(p=>p.type==='ОСЦИЛЯТОР').length>=14);
  assert(patterns.filter(p=>p.type==='КОСМІЧНИЙ КОРАБЕЛЬ').length>=7);
  assert(patterns.filter(p=>p.type==='ДОВГОЖИТЕЛЬ').length>=8);
  assert.equal(patterns.filter(p=>p.asset==='clock').length,publicProfile ? 0 : 1);
  const quick = patterns.filter(p=>p.type==='ШВИДКА МАШИНА');
  assert.equal(quick.length,publicProfile ? 2 : 10);
  if (publicProfile) {
    const policy = require('../publication-policy.json');
    assert.deepEqual(patterns.map(p=>p.id).sort(), [...policy.allowed_pattern_ids].sort());
  }
  assert(quick.every(p=>p.demo.generation>=1 && p.demo.generation<=10000));
});

for (const pattern of patterns.filter(p=>p.rle)) {
  test(`catalog ${pattern.id}: parse, population and stated behavior`,()=>{
    const {grid,width,height} = Core.parseRLE(pattern.rle);
    const initial = new Set([...grid.cells()].map(([x,y])=>`${x},${y}`));
    assert.equal(initial.size,pattern.population);
    assert.equal(width,pattern.width);
    assert.equal(height,pattern.height);
    assert(initial.size>0);
    if (!pattern.id.startsWith('not-') && pattern.id!=='and-latch')
      assert.match(pattern.source,/^https:\/\//);
    const verification=pattern.verification;
    if (!verification) return;
    let current=initial;
    if (['still','oscillator','spaceship'].includes(verification.kind)) {
      for (let generation=1;generation<=verification.period;generation++) {
        const prior=current;current=step(current);
        if (pattern.id==='phoenix') assert([...current].every(key=>!prior.has(key)));
        if (generation<verification.period && verification.kind!=='spaceship')
          assert(!same(current,initial),'A smaller period contradicts the catalog label');
      }
      const expected=verification.kind==='spaceship'
        ? translate(initial,verification.dx,verification.dy) : initial;
      assert.deepEqual(sorted(current),sorted(expected));
      if (verification.kind==='spaceship') assert(verification.dx||verification.dy);
    } else if (verification.kind==='dies') {
      for(let i=1;i<=verification.generation;i++) {
        current=step(current);
        if(i<verification.generation)assert(current.size>0,'Pattern died too early');
      }
      assert.equal(current.size,0);
    } else if (verification.kind==='emitter') {
      const source=within(initial,verification.roi);
      for(let cycle=1;cycle<=3;cycle++) {
        for(let i=0;i<verification.period;i++)current=step(current);
        assert.deepEqual(sorted(within(current,verification.roi)),sorted(source));
        assert.equal(current.size,initial.size+verification.population_gain*cycle);
      }
    } else {
      for(let i=0;i<verification.generation;i++)current=step(current);
      assert(current.size>=verification.min_population);
      assert(!same(current,initial));
    }
  });
}
