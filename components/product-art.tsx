import type { Product } from "@/lib/types";

export function ProductArt({ art, className = "" }: { art: Product["art"]; className?: string }) {
  return (
    <svg className={`product-art ${className}`} viewBox="0 0 300 230" fill="none" aria-hidden="true">
      <ellipse cx="154" cy="203" rx="75" ry="10" fill="#263C31" opacity=".1" />
      {art === "coffee" && <g transform="rotate(-7 150 120)">
        <path d="M105 34H193L202 196Q150 208 94 195Z" fill="#a36643" />
        <path d="M105 34H193L187 45H110Z" fill="#72452f" />
        <path d="M105 34L94 195L104 187L115 46Z" fill="#be835e" />
        <path d="M109 49H189" stroke="#72452f" strokeWidth="2" />
        <path d="M101 82H195L198 164H97Z" fill="#f5eedf" />
        <text x="148" y="106" textAnchor="middle" fill="#354b39" fontSize="10" fontFamily="Georgia" letterSpacing="3">MEKONG</text>
        <path d="M124 137L137 115L151 133L164 117L178 141H120" stroke="#4b634b" strokeWidth="1.5" />
        <text x="148" y="154" textAnchor="middle" fill="#354b39" fontSize="7" letterSpacing="2">MONDULKIRI COFFEE</text>
        <text x="147" y="188" textAnchor="middle" fill="#f5eedf" fontSize="6" letterSpacing="3">SLOWLY ROASTED · 250G</text>
      </g>}
      {art === "cup" && <g transform="rotate(-6 150 140)">
        <path d="M201 104H217C254 104 255 161 217 164H199" stroke="#7b8c67" strokeWidth="17" />
        <path d="M86 99H209L197 177Q194 197 149 198Q101 196 98 176Z" fill="#9ba88a" />
        <path d="M89 108L100 174Q103 191 125 192L112 109Z" fill="#afbb9e" />
        <ellipse cx="147" cy="99" rx="62" ry="18" fill="#bac2a7" />
        <ellipse cx="147" cy="98" rx="51" ry="12" fill="#647651" />
        <ellipse cx="147" cy="101" rx="46" ry="8" fill="#513b2e" />
        <path d="M125 76C109 57 143 55 129 33M157 75C144 60 175 47 159 25" stroke="#fff" strokeOpacity=".7" strokeWidth="3" strokeLinecap="round" />
        <path d="M149 153C135 139 128 153 143 167L150 173L158 166C174 149 160 139 149 153Z" stroke="#eef0df" strokeWidth="1.5" />
      </g>}
      {art === "tote" && <g transform="rotate(7 150 125)">
        <path d="M115 95V60C115 23 184 23 184 60V95" stroke="#b7aa90" strokeWidth="12" />
        <path d="M113 95V61C113 27 182 27 182 61V95" stroke="#dfd3b7" strokeWidth="8" />
        <path d="M89 83L79 194Q151 207 217 194L208 83Z" fill="#ece3cf" />
        <path d="M89 83L79 194L91 183L99 84" fill="#d8ccb4" />
        <path d="M97 91H201L209 188Q148 198 88 188Z" stroke="#d1c4aa" strokeDasharray="3 3" />
        <path d="M135 128C135 111 156 109 156 128C156 145 133 147 133 165M156 128C171 111 188 130 172 145C164 153 148 147 147 172" stroke="#627756" strokeWidth="3" />
        <path d="M115 160C122 155 128 165 122 172C116 168 110 165 115 160" fill="#627756" />
        <text x="150" y="186" textAnchor="middle" fill="#627756" fontSize="8" letterSpacing="3">TAKE IT SLOW</text>
      </g>}
      {art === "notebook" && <g transform="rotate(-13 150 120)">
        <rect x="93" y="36" width="124" height="164" rx="5" fill="#7d7995" />
        <path d="M102 40H211V193H102" fill="#faf6ed" />
        <rect x="87" y="30" width="124" height="161" rx="5" fill="#aaa5be" />
        <path d="M96 31V190" stroke="#89849f" strokeWidth="2" />
        <path d="M193 31V191" stroke="#726b89" strokeWidth="4" />
        <text x="143" y="94" textAnchor="middle" fill="#f7f1e7" fontSize="16" fontFamily="Georgia">room</text>
        <text x="143" y="114" textAnchor="middle" fill="#f7f1e7" fontSize="16" fontFamily="Georgia" fontStyle="italic">for ideas.</text>
        <path d="M132 143H155M144 132V154" stroke="#f7f1e7" />
        <path d="M113 191V211L120 206L125 211V191" fill="#d0aa77" />
      </g>}
      {art === "candle" && <g>
        <path d="M150 66C132 55 151 39 152 30C172 53 168 63 150 66" fill="#f0bb63" />
        <path d="M151 74V59" stroke="#5e4837" strokeWidth="2" />
        <path d="M98 86H202V180C202 207 98 207 98 180Z" fill="#98603e" />
        <path d="M99 92L101 180C102 190 112 193 118 194V94Z" fill="#b77a52" />
        <ellipse cx="150" cy="86" rx="52" ry="15" fill="#be8559" />
        <ellipse cx="150" cy="84" rx="45" ry="10" fill="#eee3c8" />
        <path d="M151 85V70" stroke="#473a31" strokeWidth="2" />
        <rect x="111" y="117" width="78" height="54" fill="#f3ead8" />
        <text x="150" y="135" textAnchor="middle" fill="#655c46" fontSize="7" letterSpacing="2">A QUIETER</text>
        <text x="150" y="151" textAnchor="middle" fill="#655c46" fontSize="14" fontFamily="Georgia" fontStyle="italic">moment</text>
        <text x="150" y="163" textAnchor="middle" fill="#655c46" fontSize="5" letterSpacing="2">LEMONGRASS · 180G</text>
      </g>}
      {art === "bottle" && <g transform="rotate(10 150 115)">
        <rect x="126" y="23" width="48" height="28" rx="7" fill="#426164" />
        <path d="M128 50C128 64 111 66 111 83V184C111 208 189 208 189 184V83C189 66 172 64 172 50Z" fill="#76979a" />
        <path d="M130 56C130 70 122 70 122 86V183" stroke="#97b2b2" strokeWidth="8" strokeLinecap="round" />
        <path d="M132 25V48M141 25V48M150 25V48M159 25V48M168 25V48" stroke="#587678" strokeWidth="2" />
        <path d="M151 104C137 118 161 118 149 132C136 145 162 145 150 159" stroke="#e5e9db" strokeWidth="2" />
        <text x="150" y="177" textAnchor="middle" fill="#e5e9db" fontSize="7" letterSpacing="2">MEKONG</text>
      </g>}
    </svg>
  );
}
