"""Build the finite B3/S23 collision examples and their catalog import fragment.

Coordinates here are zero-based; exported user-facing JSON uses coordinate_base=1.
Inputs only add five-cell gliders. All output clocks advance inside Life.
Run from the project root: python examples/logic/build_extensions.py
"""
from itertools import product
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from life.formats import json_chunks, rle_text

HERE = Path(__file__).resolve().parent
SIZE = 112
SE = frozenset({(0,2),(1,0),(1,2),(2,1),(2,2)})
NW = frozenset({(0,0),(0,1),(1,0),(1,2),(2,0)})
NE = frozenset({(0,0),(1,0),(1,2),(2,0),(2,1)})
def at(shape, x, y):
    return frozenset((i + x, j + y) for i, j in shape)

def box(cells):
    xs, ys = zip(*cells)
    return dict(x=min(xs), y=min(ys), width=max(xs)-min(xs)+1, height=max(ys)-min(ys)+1)

def checkpoint(generation, cells, signal, velocity=(0,0)):
    return dict(generation=generation, output_roi=box(cells), signal=signal,
                one_cells=sorted(cells), velocity_per_four=list(velocity))

def gate(group, label, description, clocks, a, b, read, truth, pins=('A','B'), prefix=()):
    return dict(group=group, label=label, description=description, clocks=clocks,
                pins=list(pins), input_cells=[a,b], checks=[*prefix, (read,truth)])

clock = at(SE,18,18)
first, second, inverse = at(NW,32,32), at(NW,48,48), at(NW,64,64)
write, data = at(SE,42,42), at(NW,57,57)
probe, reset = at(NE,24,70), at(NE,24,73)
block = {(50,50),(50,51),(51,50),(51,51)}
left = at(SE,32,32)
right = frozenset({(41,42),(41,43),(42,42),(42,44),(43,42)})
parity_clock = frozenset({(29,45),(30,43),(30,44),(31,44),(31,45)})
parity_inverse = frozenset({(59,12),(59,13),(60,11),(60,13),(61,13)})
GLIDER='glider'; BLOCK='block'
demo = [
    gate('nor','NOR','Either input glider can extinguish the same clock pulse.',
         clock,first,second, checkpoint(96,at(clock,24,24),GLIDER,(1,1)), '1000'),
    gate('or','OR','A second clock pulse inverts the shared NOR output.',
         clock|inverse,first,second, checkpoint(128,at(inverse,-32,-32),GLIDER,(-1,-1)), '0111'),
    gate('nand','NAND','Two simultaneous inputs form an AND block that intercepts the delayed readout glider.',
         probe,write,data, checkpoint(120,at(probe,30,-30),GLIDER,(1,-1)), '1110'),
    gate('xnor','XNOR','One input extinguishes the clock glider. Two inputs annihilate each other and let it pass.',
         parity_clock,left,right, checkpoint(80,at(parity_clock,20,-20),GLIDER,(1,-1)), '1001'),
    gate('xor','XOR','A second clock glider inverts XNOR, giving the same output for inputs 01 and 10.',
         parity_clock|parity_inverse,left,right, checkpoint(112,at(parity_inverse,-28,28),GLIDER,(-1,1)), '0110'),
    gate('inhibit','Inhibitor · A AND NOT B','Glider A reaches the output only if glider B does not extinguish it.',
         frozenset(),clock,first, checkpoint(96,at(clock,24,24),GLIDER,(1,1)), '0010'),
    gate('implies','Implication · A ⇒ B','A clock glider inverts the output of the A AND NOT B inhibitor.',
         second,clock,first, checkpoint(120,at(second,-30,-30),GLIDER,(-1,-1)), '1101'),
    gate('block-memory','One-bit memory · write and reset','At generation 60 the memory stores D. A delayed R=1 glider clears it. R=0 keeps the stored bit.',
         write,data,reset, checkpoint(144,block,BLOCK), '0010', ('D','R'),
         ((checkpoint(60,block,BLOCK), '0011'),)),
]

def main():
    manifest = dict(format='exact-life-logic-extensions', version=1, rule='B3/S23',
                    width=SIZE, height=SIZE, wrap=False, coordinate_base=0, demos=[])
    catalog=[]
    for d in demo:
        folder=HERE/d['group']
        folder.mkdir(exist_ok=True)
        record=dict(id=d['group'], label=d['label'], description=d['description'],
                    pins=d['pins'], fixed_cells=sorted(d['clocks']),
                    input_cells=[sorted(c) for c in d['input_cells']],
                    checkpoints=[c for c,_ in d['checks']], cases=[])
        for n,(a,b) in enumerate(product((0,1),repeat=2)):
            code=f'{a}{b}'
            base=f"{d['group']}/{code}"
            cells=d['clocks'] | (d['input_cells'][0] if a else frozenset()) | (d['input_cells'][1] if b else frozenset())
            outputs=[int(table[n]) for _,table in d['checks']]
            read=d['checks'][-1][0]; out=outputs[-1]; count=out*len(read['one_cells'])
            (HERE/(base+'.json')).write_text(''.join(json_chunks(SIZE,SIZE,False,0,sorted(cells))),encoding='utf-8',newline='\n')
            rle=rle_text(SIZE,SIZE,False,0,cells)
            # These RLE assets are byte-preserved by Git and were published with CRLF.
            (HERE/(base+'.rle')).write_text(f"#N {d['group']} inputs={code}\n#C B3/S23, single shot; sample generation {read['generation']}; details in extended-truth-tables.json.\n"+rle,encoding='utf-8',newline='\r\n')
            record['cases'].append(dict(inputs=[a,b], outputs=outputs, state=base+'.json', rle=base+'.rle'))
            roi=read['output_roi']; x,y=roi['x']+1,roi['y']+1
            region=f"{x}.{y}–{x+roi['width']-1}.{y+roi['height']-1}"
            named=f"{d['pins'][0]}={a}, {d['pins'][1]}={b}"
            note=f"{d['description']} With {named}, the output at generation {read['generation']} is {out} ({count} live cells in {region})."
            audit=dict(kind='logic',generation=read['generation'],output_roi=roi,expected_output=out,
                       expected_population=count,signal=read['signal'],coordinate_base=0)
            if len(outputs)>1:
                audit['checkpoints']=[dict(generation=c['generation'],output_roi=c['output_roi'],expected_output=o,expected_population=o*len(c['one_cells'])) for (c,_),o in zip(d['checks'],outputs)]
            catalog.append(dict(id=f"logic-{d['group']}-{code}",group='logic-'+d['group'],inputs=[a,b],pins=d['pins'],
                                group_name=d['label'],name=f"{d['label']} · {named} → {out}",
                                type='LOGIC CIRCUIT',note=note,rle=rle,width=SIZE,height=SIZE,population=len(cells),
                                provenance='original',source='examples/logic/'+base+'.rle',verification=audit))
        manifest['demos'].append(record)
    (HERE/'extended-truth-tables.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
    run=ROOT/'.run'; run.mkdir(exist_ok=True)
    (run/'logic-catalog-additions.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')

if __name__=='__main__':
    main()
