const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Core = require('../web/core.js');
const Catalog = require('../web/catalog.js');
const root = path.join(__dirname,'../web');
const entries = JSON.parse(fs.readFileSync(path.join(root,'patterns.json'),'utf8'));

for (const p of entries.filter(p=>p.asset&&p.asset!=='clock')) {
  test(`offline device ${p.id}: exact artifact, usable in editor and authored monitor placement`,()=>{
    const context = {window:{}};
    vm.runInNewContext(fs.readFileSync(path.join(root,'patterns',p.asset+'.js'),'utf8'),context);
    const original = fs.readFileSync(path.join(root,p.file));
    assert.equal(crypto.createHash('sha256').update(original).digest('hex'),p.sha256);
    const rle = context.window.LIFE_PATTERN_ASSETS[p.asset];
    assert.equal(rle,original.toString('utf8').replace(/\r\n/g,'\n'));
    const {grid,width,height,metadata} = Core.parseRLE(rle);
    assert.deepEqual([width,height,grid.population],[p.width,p.height,p.population]);
    const place = Catalog.monitorPlacement(p,rle,{width:100000,height:100000,wrap:true});
    assert.equal(place.text,rle); assert.equal(place.x,metadata.origin_x); assert.equal(place.y,metadata.origin_y);
    assert.equal(metadata.wrap,0); assert(metadata.width>=width+place.x); assert(metadata.height>=height+place.y);
    assert.equal(p.preview.levels.length,p.preview.width*p.preview.height);
    assert(/^[0-9a-f]+$/.test(p.preview.levels));
  });
}

test('all 32 selectable input cases load the independently verified physical gate fixtures',async()=>{
  let count=0;
  for(const p of entries.filter(p=>p.variants)) {
    assert.equal(p.variants.length,4);
    for(let i=0;i<p.variants.length;i++) {
      const v=Catalog.caseOf(p,i), rle=await Catalog.getRLE(v), parsed=Core.parseRLE(rle);
      const id=p.id.slice('logic-'.length), bits=v.inputs.join('');
      const disk=fs.readFileSync(path.join(__dirname,'../examples/logic',id,bits+'.rle'),'utf8').replace(/\r\n/g,'\n');
      assert.equal(rle,disk); assert.equal(parsed.grid.population,v.population);
      assert.deepEqual([parsed.width,parsed.height],[112,112]);
      assert.equal(Catalog.monitorPlacement(v,rle,{width:100000,height:100000,wrap:true}).text,rle);
      assert(Catalog.readoutDescription(v.verification).includes(String(v.verification.generation)));
      count++;
    }
  }
  assert.equal(count,32);
});

test('ordinary monitor stamps keep the current field, topology and centered placement in compact RLE',()=>{
  const p=entries.find(p=>p.id==='glider');
  const place=Catalog.monitorPlacement(p,p.rle,{width:999,height:1001,wrap:true});
  const parsed=Core.parseRLE(place.text);
  assert.deepEqual(parsed.metadata,{width:999,height:1001,origin_x:498,origin_y:499,wrap:1,generation:0});
  assert.equal(parsed.grid.population,5);
});
