/** Original, deterministic Critter Call artwork. Each layer shares a 320 × 240 canvas. */
export const CHARACTER_PARTS = Object.freeze({
  bodies: Object.freeze(['pill', 'capsule', 'pear', 'bean', 'pebble', 'dumpling', 'squircle', 'bell', 'cloud', 'droplet']),
  backgrounds: Object.freeze(['studio', 'observatory', 'garden', 'coast', 'library', 'greenhouse', 'sunrise', 'moonbase']),
  faces: Object.freeze(['bright', 'content', 'curious', 'focused', 'delighted', 'wink', 'sleepy', 'surprised']),
  accessories: Object.freeze(['none', 'headphones', 'beanie', 'bow', 'glasses', 'beret', 'sprout', 'antenna', 'headband', 'party-hat']),
  decorations: Object.freeze(['none', 'mug', 'plant', 'notebook', 'desk-buddy', 'sticky-notes', 'tea']),
  palettes: Object.freeze(['butter', 'lilac', 'mint', 'peach', 'sky', 'rose', 'periwinkle', 'sage']),
});

const INK = '#343449';
const PALETTES = {
  butter: ['#ffe596', '#edbd65', '#fff4c9', '#a88ce2', '#76639f'],
  lilac: ['#cfb8f1', '#a78bce', '#eee1ff', '#f3c37f', '#bd8a55'],
  mint: ['#a8dfc8', '#76bba9', '#dcf8e9', '#edaaa4', '#bd757b'],
  peach: ['#ffc4a1', '#e89d85', '#ffe9d2', '#91bdd3', '#618ba8'],
  sky: ['#a9dceb', '#7bb4d0', '#e0f6fc', '#e4b0cd', '#b880a1'],
  rose: ['#f3b7cc', '#d88da9', '#ffe1ed', '#a1cdb3', '#6d9d8a'],
  periwinkle: ['#b6c4f5', '#889bd7', '#e7edff', '#eac67e', '#b49253'],
  sage: ['#c7d7a9', '#9eb887', '#eff5d9', '#c3a7d8', '#9277ad'],
};
const BODY_PATHS = {
  pill: 'M160 57C124 57 106 81 106 115V211H214V115C214 81 196 57 160 57Z',
  capsule: 'M128 67H192C214 67 230 87 230 112V178C230 202 211 215 191 215H129C109 215 90 202 90 178V112C90 87 106 67 128 67Z',
  pear: 'M160 57C134 57 129 78 123 98C116 121 96 141 96 170C96 201 120 215 160 215S224 201 224 170C224 141 204 121 197 98C191 78 186 57 160 57Z',
  bean: 'M147 60C119 58 101 77 104 106C106 125 87 137 91 168C95 204 131 217 169 212C209 207 232 188 226 155C222 132 204 127 207 102C210 76 189 58 169 65C161 68 157 62 147 60Z',
  pebble: 'M160 65C122 63 89 93 87 140C84 185 111 213 155 214C198 216 231 195 233 152C235 106 207 66 160 65Z',
  dumpling: 'M160 66C137 83 112 79 100 111C91 134 80 156 88 179C97 207 126 215 160 215S223 207 232 179C240 156 229 134 220 111C208 79 183 83 160 66Z',
  squircle: 'M127 65H193Q226 65 226 98V181Q226 214 193 214H127Q94 214 94 181V98Q94 65 127 65Z',
  bell: 'M160 59C126 59 113 81 110 117C108 146 96 161 88 183Q79 210 109 212H211Q241 210 232 183C224 161 212 146 210 117C207 81 194 59 160 59Z',
  cloud: 'M109 95C107 73 128 60 145 70C159 47 190 54 196 77C219 73 237 93 228 115C251 131 243 160 229 173L225 211H95L91 173C69 157 76 127 94 119C87 109 96 98 109 95Z',
  droplet: 'M162 49C155 69 105 91 98 133C88 182 113 215 160 215C205 215 232 184 224 144C218 108 182 88 162 49Z',
};

export async function hashText(text) {
  if (typeof text !== 'string') throw new TypeError('Character text must be a string.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function traitsFor(hash, overrides) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new TypeError('Character hash must be 64 lowercase hexadecimal characters.');
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides))) {
    throw new TypeError('Character overrides must be a plain object.');
  }
  const keys = { body: 'bodies', background: 'backgrounds', face: 'faces', accessory: 'accessories', decoration: 'decorations', palette: 'palettes' };
  for (const key of Reflect.ownKeys(overrides)) {
    if (!Object.hasOwn(keys, key)) throw new TypeError(`Unknown character override: ${String(key)}`);
    if (!CHARACTER_PARTS[keys[key]].includes(overrides[key])) throw new TypeError(`Invalid character ${key}.`);
  }
  return Object.fromEntries(Object.entries(keys).map(([key, list], index) => [
    key, Object.hasOwn(overrides, key) ? overrides[key]
      : CHARACTER_PARTS[list][Number.parseInt(hash.slice(index * 8, index * 8 + 8), 16) % CHARACTER_PARTS[list].length],
  ]));
}

function svg(id, title, description, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240" role="img" aria-labelledby="${id}-title ${id}-desc"><title id="${id}-title">${title}</title><desc id="${id}-desc">${description}</desc>${content}</svg>`;
}

function backgroundArt(name, id) {
  const scenes = {
    studio: `<rect width="320" height="240" fill="#eae4ec"/><path d="M0 166H320V240H0Z" fill="#d8d5e2"/><rect x="18" y="25" width="108" height="114" rx="13" fill="#fcf3d9" stroke="#c4bbc9" stroke-width="3"/><path d="M72 26V138M19 82H125" stroke="#e1d6be" stroke-width="5"/><circle cx="45" cy="54" r="14" fill="#f9db95"/><path d="M20 120Q66 91 125 119V138H20" fill="#b7cdbc"/><rect x="237" y="38" width="55" height="66" rx="5" fill="#fff4e7" stroke="#b8a8b6" stroke-width="3"/><path d="M244 91L259 66L271 78L284 57V97H244Z" fill="#c4b1d8"/><path d="M255 171V123M231 123H279L267 103H243Z" fill="#f4cc85" stroke="#b7a78f" stroke-width="2"/><ellipse cx="255" cy="172" rx="18" ry="4" fill="#aaa0b6"/>`,
    observatory: `<rect width="320" height="240" fill="#34334f"/><circle cx="161" cy="105" r="124" fill="#444365"/><path d="M161 0V202M43 63H280M39 141H284" stroke="#66627e" stroke-width="3"/><circle cx="64" cy="62" r="25" fill="#f2c0bb"/><path d="M27 74Q64 45 103 52Q74 81 27 74Z" fill="none" stroke="#f5dabd" stroke-width="4"/><circle cx="265" cy="115" r="15" fill="#9acbdf"/><path d="M33 30H39M36 27V33M250 33H258M254 29V37M287 77H293M290 74V80M93 145H99M96 142V148" stroke="#fff1d4" stroke-width="2" stroke-linecap="round"/><circle cx="208" cy="40" r="2" fill="#fff1d4"/><circle cx="26" cy="126" r="2" fill="#fff1d4"/><path d="M0 193Q160 171 320 193V240H0Z" fill="#615776"/>`,
    garden: `<rect width="320" height="240" fill="#dcf0e9"/><circle cx="265" cy="43" r="25" fill="#fff2be"/><path d="M17 56Q29 38 44 52Q64 45 69 61H17M199 86Q210 71 224 82Q242 75 250 89H199" fill="#fffdf4"/><path d="M0 135Q55 97 126 140T320 125V240H0Z" fill="#b6d6b1"/><path d="M0 176Q75 127 159 171T320 155V240H0Z" fill="#8fbea3"/><path d="M270 172V94" stroke="#8a9e7f" stroke-width="7"/><circle cx="270" cy="89" r="29" fill="#80b79b"/><circle cx="251" cy="103" r="18" fill="#97c5a2"/><path d="M29 199V159M21 170L29 176L38 165" stroke="#649b83" stroke-width="3"/><circle cx="29" cy="156" r="7" fill="#f0bdc5"/><circle cx="58" cy="182" r="4" fill="#fae2ad"/>`,
    coast: `<rect width="320" height="240" fill="#dceeea"/><circle cx="68" cy="54" r="28" fill="#fff1be"/><path d="M197 38Q210 21 225 34Q243 29 249 44H197M258 72Q270 58 283 71H307" fill="#fffaf0"/><path d="M0 125Q42 110 83 125T167 124T251 122T335 127V240H0Z" fill="#96ced5"/><path d="M0 153Q50 133 98 152T197 149T320 152V240H0Z" fill="#71b6c8"/><path d="M0 193Q87 167 169 190T320 181V240H0Z" fill="#ecd6b0"/><path d="M255 104V167M257 111L282 151H257Z" fill="#fff5df" stroke="#a38b83" stroke-width="2"/><path d="M241 169H287L277 178H250Z" fill="#c38f8b"/><path d="M22 146H48M286 135H304M63 173H84" stroke="#c1e4e5" stroke-width="3" stroke-linecap="round"/>`,
    library: `<rect width="320" height="240" fill="#eadbce"/><rect x="17" y="20" width="92" height="167" rx="5" fill="#b59d91"/><path d="M22 73H104M22 128H104M22 183H104" stroke="#8e7c7a" stroke-width="5"/><path d="M29 35V69M42 30V69M57 38V69M75 30L87 68M30 90V124M45 85V124M59 92V124M81 87V124M29 146V179M43 140V179M61 145V179M79 140L91 178" stroke="#e0bf9c" stroke-width="9"/><path d="M42 30V69M59 92V124M43 140V179" stroke="#9db9af" stroke-width="9"/><rect x="240" y="33" width="53" height="70" rx="20" fill="#c6b9cf"/><circle cx="266" cy="64" r="15" fill="#f7dfb0"/><path d="M266 64V53M266 64L274 68" stroke="#80778e" stroke-width="2" stroke-linecap="round"/><path d="M0 196H320V240H0Z" fill="#cfb8a9"/><path d="M254 178V131M234 132H280L268 110H246Z" fill="#bbafa0" stroke="#8e7c7a" stroke-width="2"/>`,
    greenhouse: `<rect width="320" height="240" fill="#e5f0da"/><path d="M0 117Q76 73 157 116T320 107V240H0Z" fill="#c1d6ad"/><path d="M21 207V49L160 9L299 49V207M160 9V207M21 91H299M21 150H299" fill="none" stroke="#9db7a8" stroke-width="5"/><path d="M38 201Q48 144 29 127M43 174Q24 170 29 153Q45 151 43 174M45 160Q59 153 62 135Q42 131 45 160M271 203Q264 155 286 127M273 178Q293 173 292 154Q271 155 273 178M275 163Q257 152 259 136Q276 138 275 163" fill="#87b699" stroke="#68977e" stroke-width="2"/><path d="M26 192H58L54 215H30ZM256 192H290L286 215H260Z" fill="#d4a58d"/><path d="M0 219H320" stroke="#a2b99c" stroke-width="15"/>`,
    sunrise: `<rect width="320" height="240" fill="#f3dfda"/><circle cx="242" cy="84" r="44" fill="#f5bd96"/><path d="M0 133L50 87L96 132L146 104L205 153L266 119L320 143V240H0Z" fill="#c7bbd3"/><path d="M0 177Q65 131 142 172T320 161V240H0Z" fill="#a7b6c6"/><path d="M0 199Q83 177 167 200T320 189V240H0Z" fill="#90a9b2"/><path d="M0 24H320M40 0V212M280 0V212" stroke="#f9f0e4" stroke-width="7"/><path d="M69 53H101M85 37V69" stroke="#fff2de" stroke-width="2" stroke-linecap="round"/>`,
    moonbase: `<rect width="320" height="240" fill="#d4dbe7"/><rect x="19" y="23" width="282" height="144" rx="45" fill="#aaaec7"/><rect x="26" y="30" width="268" height="130" rx="39" fill="#343b5a"/><circle cx="258" cy="68" r="24" fill="#a6ccda"/><path d="M247 49Q270 58 267 84M238 64L277 72" fill="none" stroke="#82afc4" stroke-width="5"/><path d="M27 133Q75 108 123 136T219 135T294 129V153Q294 160 282 160H38Q26 160 26 147Z" fill="#777c9c"/><circle cx="59" cy="56" r="2" fill="#fff3d5"/><circle cx="212" cy="45" r="2" fill="#fff3d5"/><path d="M107 43H115M111 39V47M276 108H282M279 105V111" stroke="#fff3d5" stroke-width="2"/><path d="M0 187H320V240H0Z" fill="#b6bdd0"/><rect x="28" y="180" width="43" height="14" rx="4" fill="#929eb7"/><circle cx="39" cy="187" r="2" fill="#b6e5cf"/><path d="M48 187H62" stroke="#e6d4af" stroke-width="2"/>`,
  };
  return svg(`${id}-bg`, `${name} workspace`, 'A quiet illustrated workspace behind the character.', scenes[name]);
}

function faceArt(name) {
  const openEye = (x, y = 116, radius = 9) => `<ellipse cx="${x}" cy="${y}" rx="${radius}" ry="12" fill="${INK}"/><ellipse cx="${x - 2}" cy="${y - 4}" rx="3" ry="4" fill="#fffdf5"/><circle cx="${x + 3}" cy="${y + 5}" r="1.5" fill="#fffdf5" opacity=".65"/>`;
  const smile = '<path d="M151 140Q160 150 169 140" fill="none" stroke-width="3.3"/>';
  const brows = '<path d="M130 96Q137 92 144 96M176 96Q183 92 190 96" fill="none" stroke-width="3"/>';
  const faces = {
    bright: `${brows}${openEye(137)}${openEye(183)}${smile}`,
    content: '<path d="M128 117Q137 106 146 117M174 117Q183 106 192 117" fill="none" stroke-width="4"/>' + smile,
    curious: `<path d="M128 96Q137 88 146 94M175 94L190 98" fill="none" stroke-width="3"/>${openEye(137, 116, 10)}${openEye(182, 118, 8)}<path d="M155 141Q161 144 167 138" fill="none" stroke-width="3"/>`,
    focused: `<path d="M128 98L145 101M175 101L192 98" fill="none" stroke-width="3"/>${openEye(137)}${openEye(183)}<path d="M154 142H166" fill="none" stroke-width="3"/>`,
    delighted: '<path d="M128 119L137 111L146 119M174 119L183 111L192 119" fill="none" stroke-width="4"/><path d="M150 139Q160 142 170 139Q169 155 160 155Q151 155 150 139Z" fill="#63435a" stroke-width="2"/><path d="M155 150Q160 147 165 150" fill="none" stroke="#f3a9b9" stroke-width="4"/>',
    wink: `${openEye(137)}<path d="M174 116Q183 109 192 117" fill="none" stroke-width="4"/>${smile}<path d="M128 96Q137 92 145 96M175 96Q184 90 192 95" fill="none" stroke-width="3"/>`,
    sleepy: '<path d="M128 114Q137 120 146 114M174 114Q183 120 192 114M131 117L129 120M189 117L191 120" fill="none" stroke-width="3.5"/><ellipse cx="161" cy="142" rx="4" ry="5" fill="#63435a" stroke-width="2"/>',
    surprised: `${openEye(137, 115, 10)}${openEye(183, 115, 10)}<path d="M128 93Q137 86 146 93M174 93Q183 86 192 93" fill="none" stroke-width="3"/><ellipse cx="160" cy="144" rx="6" ry="8" fill="#63435a" stroke-width="2"/>`,
  };
  return `<g stroke="${INK}" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="120" cy="134" rx="10" ry="5" fill="#ee91a3" opacity=".36" stroke="none"/><ellipse cx="200" cy="134" rx="10" ry="5" fill="#ee91a3" opacity=".36" stroke="none"/>${faces[name]}</g>`;
}

function accessoryArt(name, accent, shade) {
  const parts = {
    none: '',
    headphones: `<path d="M102 120V105Q102 57 160 57Q218 57 218 105V120" fill="none" stroke="${INK}" stroke-width="9"/><path d="M102 104Q103 61 160 61Q215 61 218 104" fill="none" stroke="${accent}" stroke-width="5"/><rect x="94" y="107" width="17" height="35" rx="8" fill="${accent}" stroke-width="2"/><rect x="209" y="107" width="17" height="35" rx="8" fill="${accent}" stroke-width="2"/><path d="M220 140Q217 155 199 155" fill="none" stroke-width="3"/><rect x="188" y="151" width="16" height="7" rx="3" fill="${shade}" stroke-width="1.5"/>`,
    beanie: `<path d="M111 78Q111 40 160 39Q209 40 209 78Z" fill="${accent}" stroke-width="2.5"/><path d="M130 47L126 74M149 42L148 75M170 42L172 75M190 48L195 74" stroke="${shade}" stroke-width="2" opacity=".65"/><rect x="106" y="72" width="108" height="16" rx="7" fill="${shade}" stroke-width="2.5"/><circle cx="160" cy="35" r="10" fill="${accent}" stroke-width="2"/><rect x="151" y="76" width="18" height="9" rx="2" fill="#fff0d5" stroke="none"/>`,
    bow: `<path d="M173 65L182 43Q185 39 190 43L205 54L224 47Q229 46 229 51L226 78Q225 82 221 80L204 69L181 76Q175 78 173 65Z" fill="${accent}" stroke-width="2.5"/><path d="M183 57L198 63M219 58L208 64" stroke="${shade}" stroke-width="2"/><ellipse cx="203" cy="63" rx="9" ry="10" fill="${shade}" stroke-width="2"/>`,
    glasses: `<g fill="#fff" fill-opacity=".1" stroke-width="3"><rect x="121" y="103" width="34" height="29" rx="12"/><rect x="165" y="103" width="34" height="29" rx="12"/><path d="M155 113Q160 109 165 113M121 111L112 108M199 111L208 108" fill="none"/></g><path d="M125 109H135M169 109H179" stroke="#fffdf5" stroke-width="2.5" opacity=".7"/>`,
    beret: `<path d="M108 72Q103 57 122 48Q148 34 184 45Q211 46 219 63Q217 79 193 78L123 79Z" fill="${accent}" stroke-width="2.5"/><path d="M163 43L168 33" stroke="${shade}" stroke-width="6"/><path d="M120 76Q160 69 200 77" fill="none" stroke="${shade}" stroke-width="8"/>`,
    sprout: `<path d="M162 71Q155 52 163 39" fill="none" stroke="#698f7a" stroke-width="4"/><path d="M160 53Q137 58 134 37Q154 31 160 53Z" fill="#acd09e" stroke="#698f7a" stroke-width="2"/><path d="M162 44Q161 25 183 27Q184 46 162 44Z" fill="#badca9" stroke="#698f7a" stroke-width="2"/>`,
    antenna: `<path d="M159 67V43" fill="none" stroke="${shade}" stroke-width="4"/><circle cx="159" cy="36" r="10" fill="${accent}" stroke-width="2.5"/><circle cx="156" cy="33" r="3" fill="#fff5dc" stroke="none"/><ellipse cx="159" cy="69" rx="15" ry="5" fill="${shade}" stroke-width="2"/>`,
    headband: `<path d="M108 85Q160 47 212 85" fill="none" stroke="${shade}" stroke-width="12"/><path d="M109 82Q160 45 211 82" fill="none" stroke="${accent}" stroke-width="7"/><path d="M187 67L199 51L207 69L201 81Z" fill="#fff0cf" stroke-width="2"/><circle cx="200" cy="68" r="3" fill="${accent}" stroke="none"/>`,
    'party-hat': `<path d="M126 73L154 17L188 73Q158 83 126 73Z" fill="${accent}" stroke-width="2.5"/><path d="M140 45L167 37M132 62L179 53" stroke="#fff2d9" stroke-width="7"/><circle cx="154" cy="17" r="7" fill="${shade}" stroke-width="2"/><path d="M126 74Q160 83 188 74" fill="none" stroke="${shade}" stroke-width="5"/>`,
  };
  return `<g stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">${parts[name]}</g>`;
}

function characterArt(traits, id) {
  const [base, shade, light, accent, accentShade] = PALETTES[traits.palette];
  const gradient = `${id}-body`;
  const body = `<defs><linearGradient id="${gradient}" x1="0" y1="0" x2=".7" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="${light}"/><stop offset=".43" stop-color="${base}"/><stop offset="1" stop-color="${shade}"/></linearGradient></defs><g stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"><path d="M107 143Q84 137 84 160L88 192Q92 202 101 194L114 165M213 143Q236 137 236 160L232 192Q228 202 219 194L206 165" fill="${shade}"/><path d="${BODY_PATHS[traits.body]}" fill="url(#${gradient})"/><path d="M122 91Q130 79 142 79" fill="none" stroke="${light}" stroke-width="7" stroke-linecap="round" opacity=".7"/><ellipse cx="160" cy="201" rx="33" ry="6" fill="${shade}" stroke="none" opacity=".35"/></g>`;
  const hands = `<path d="M105 195Q100 191 96 195L93 205Q94 211 102 210L110 209M215 195Q220 191 224 195L227 205Q226 211 218 210L210 209" fill="${base}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`;
  return svg(`${id}-char`, `${traits.palette} ${traits.body} character`, `An original soft ${traits.body} desk companion with a ${traits.face} expression and ${traits.accessory} accessory.`,
    `${body}${faceArt(traits.face)}${accessoryArt(traits.accessory, accent, accentShade)}${hands}`);
}

function foregroundArt(traits, id) {
  const [, , light, accent, shade] = PALETTES[traits.palette];
  const objects = {
    none: '',
    mug: `<path d="M263 186H272Q282 186 282 196Q282 205 271 204H267" fill="none" stroke="${INK}" stroke-width="2.5"/><path d="M244 183H269V203Q269 210 257 210Q244 210 244 203Z" fill="${accent}" stroke="${INK}" stroke-width="2"/><ellipse cx="256.5" cy="183" rx="12.5" ry="3" fill="#fff0d9" stroke="${INK}" stroke-width="2"/><path d="M250 171Q246 165 251 159M260 173Q256 167 261 161" fill="none" stroke="#fff9ec" stroke-width="2" stroke-linecap="round" opacity=".8"/>`,
    plant: '<path d="M264 192V166M263 181Q244 182 245 166Q260 163 263 181M265 172Q266 155 282 157Q283 174 265 172" fill="#95bb9c" stroke="#597e71" stroke-width="2"/><path d="M250 188H278L274 210H254Z" fill="#e1ab94" stroke="#755f66" stroke-width="2"/><path d="M255 193H273" stroke="#f4d3b7" stroke-width="2"/>',
    notebook: `<path d="M242 196L281 193L288 207L246 211Z" fill="${accent}" stroke="${INK}" stroke-width="2"/><path d="M245 200L283 197M249 205L285 202" stroke="#fff3d9" stroke-width="2"/><path d="M247 191L273 185" stroke="${shade}" stroke-width="4" stroke-linecap="round"/>`,
    'desk-buddy': `<path d="M255 207L248 194L255 179L269 179L278 194L271 207Z" fill="${accent}" stroke="${INK}" stroke-width="2"/><circle cx="258" cy="192" r="2" fill="${INK}"/><circle cx="267" cy="192" r="2" fill="${INK}"/><path d="M260 199Q263 201 266 199" fill="none" stroke="${INK}" stroke-width="1.5"/><path d="M262 178V171M257 171H267" stroke="${shade}" stroke-width="2"/>`,
    'sticky-notes': `<path d="M242 191H269L273 210H246Z" fill="#f9dea0" stroke="#a59579" stroke-width="1.5"/><path d="M257 185H283L280 204H254Z" fill="${accent}" stroke="${shade}" stroke-width="1.5"/><path d="M261 191H276M260 196H271" stroke="${shade}" stroke-width="1.5" stroke-linecap="round"/>`,
    tea: `<path d="M247 191H276Q273 208 262 208Q251 208 247 191Z" fill="${light}" stroke="${INK}" stroke-width="2"/><path d="M277 192Q289 189 284 199L276 202" fill="none" stroke="${INK}" stroke-width="2"/><ellipse cx="261" cy="191" rx="14" ry="3" fill="#b6886a" stroke="${INK}" stroke-width="1.5"/><path d="M243 210H282" stroke="${shade}" stroke-width="3" stroke-linecap="round"/><path d="M259 180Q252 173 260 165" fill="none" stroke="#fff7e9" stroke-width="2" stroke-linecap="round"/>`,
  };
  return svg(`${id}-fg`, 'A little work desk', 'A softly outlined laptop on a wooden desk with an optional small desk decoration.',
    `<path d="M0 210H320V240H0Z" fill="#d5b59c"/><path d="M0 210H320" stroke="#695e66" stroke-width="2.5"/><path d="M0 219H320" stroke="#f2d6b5" stroke-width="3"/><path d="M0 237H320" stroke="#b69788" stroke-width="3"/><ellipse cx="160" cy="212" rx="70" ry="5" fill="#a58e85" opacity=".35"/>${objects[traits.decoration]}<path d="M111 178Q111 173 117 173H203Q209 173 209 178V207H111Z" fill="#edf0f3" stroke="${INK}" stroke-width="2.3"/><path d="M115 178H205" stroke="#fff" stroke-width="2" opacity=".85"/><path d="M103 207H217L213 212H107Z" fill="#c8cbd8" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M148 208H172" stroke="#a3a9bd" stroke-width="2"/><path d="M160 184L163 190L170 191L165 196L166 203L160 200L154 203L155 196L150 191L157 190Z" fill="${accent}" stroke="${shade}" stroke-width="1"/>`);
}

export function characterFromHash(hash, overrides = {}) {
  const traits = traitsFor(hash, overrides);
  // The complete hash prevents collisions when layers from multiple characters share a DOM.
  const id = `critter-${hash}-${Object.values(traits).join('-')}`;
  return {
    hash, width: 320, height: 240, traits,
    layers: {
      background: backgroundArt(traits.background, id),
      character: characterArt(traits, id),
      foreground: foregroundArt(traits, id),
    },
  };
}

export async function characterFromText(text, overrides = {}) {
  return characterFromHash(await hashText(text), overrides);
}
