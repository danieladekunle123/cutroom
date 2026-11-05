// One small set of 16px outline icons, built with DOM calls so no HTML strings are needed.
(function (root) {
  const NS = 'http://www.w3.org/2000/svg';
  const SHAPES = {
    play: { fill: true, d: 'M4.5 2.8v10.4L13 8z' },
    pause: { fill: true, d: 'M4 2.5h3v11H4zM9 2.5h3v11H9z' },
    plus: { d: 'M8 3v10M3 8h10' },
    minus: { d: 'M3 8h10' },
    x: { d: 'M4 4l8 8M12 4l-8 8' },
    trash: { d: 'M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6l.7-8.5' },
    grip: { fill: true, d: 'M5 3h2v2H5zM9 3h2v2H9zM5 7h2v2H5zM9 7h2v2H9zM5 11h2v2H5zM9 11h2v2H9z' },
    volume: { d: 'M2.5 6v4H5l3.5 3V3L5 6zM11 5.5a3.5 3.5 0 0 1 0 5' },
    mute: { d: 'M2.5 6v4H5l3.5 3V3L5 6zM11 6l3 4M14 6l-3 4' },
  };

  function icon(name) {
    const shape = SHAPES[name];
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', shape.fill ? 'icon icon-fill' : 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', shape.d);
    svg.appendChild(path);
    return svg;
  }

  // Each site's own mark, in its own colour. TikTok's is white here because the app is black.
  const LOGOS = {
    youtube: { name: 'YouTube', paths: [['#ffffff', 'M9.545 15.568V8.432L15.818 12z'], ['#ff0000', "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"]] },
    tiktok: { name: 'TikTok', paths: [['#ffffff', "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"]] },
    twitch: { name: 'Twitch', paths: [['#9146ff', "M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"]] },
  };

  function logo(site, size = 16) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('class', 'logo');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', LOGOS[site].name);
    for (const [fill, d] of LOGOS[site].paths) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', fill);
      svg.appendChild(path);
    }
    return svg;
  }

  root.icon = icon;
  root.logo = logo;
  root.LOGO_SITES = Object.keys(LOGOS);
  root.logoName = (site) => LOGOS[site].name;
})(globalThis);
