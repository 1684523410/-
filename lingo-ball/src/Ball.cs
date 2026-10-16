using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace LingoBall
{
    /// <summary>Round, always-on-top, per-pixel-alpha floating ball.</summary>
    class Ball : Form
    {
        public enum State { Off, Starting, On, Error }
        State state = State.Off;
        bool hover, attention;
        float spin;
        readonly Timer anim = new Timer { Interval = 40 };
        Point downScreen, downLoc;
        bool down, dragged;
        int size, margin;
        // ---- motion effects: click squash + water-drop stretch while dragging ----
        readonly Timer fx = new Timer { Interval = 15 };
        readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
        double lastT;
        float scale = 1f, scaleV, scaleTarget = 1f;       // click pulse (spring)
        float stretch, stretchV;                            // drag deformation (spring)
        float velX, velY, dirAngle;                         // smoothed drag velocity, px/s
        PointF lastPos; bool hasLast;
        string skin = "glass";
        Bitmap skinImg;

        public static Bitmap LoadSkin(string name)
        {
            try
            {
                var st = typeof(Ball).Assembly.GetManifestResourceStream("LingoBall.skin." + name + ".png");
                return st == null ? null : new Bitmap(st);
            }
            catch { return null; }
        }

        public void SetSkin(string name)
        {
            skin = string.IsNullOrEmpty(name) ? "glass" : name;
            skinImg?.Dispose();
            skinImg = skin == "classic" ? null : LoadSkin(skin);
            Render();
        }

        public event Action Clicked;
        public event Action<Point> RightClicked;
        public event Action Moved;

        public Ball()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            size = Scale(60);
            margin = Scale(20);
            Size = new Size(size + margin * 2, size + margin * 2);
            fx.Tick += (s, e) => StepFx();
            anim.Tick += (s, e) => { spin = (spin + 12) % 360; Render(); };
        }

        int Scale(int v)
        {
            using (var g = Graphics.FromHwnd(IntPtr.Zero)) return (int)Math.Round(v * g.DpiX / 96f);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x00080000 /*WS_EX_LAYERED*/ | 0x00000080 /*WS_EX_TOOLWINDOW*/ | 0x08000000 /*WS_EX_NOACTIVATE*/;
                return cp;
            }
        }

        protected override bool ShowWithoutActivation => true;

        public void SetState(State s, bool needsAttention = false)
        {
            state = s; attention = needsAttention;
            anim.Enabled = s == State.Starting || attention;
            Render();
        }

        protected override void OnShown(EventArgs e) { base.OnShown(e); Render(); }
        protected override void OnLocationChanged(EventArgs e) { base.OnLocationChanged(e); if (IsHandleCreated) Render(); }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Render(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Render(); base.OnMouseLeave(e); }

        /// <summary>The ball itself on screen (the window has a transparent margin for the effects).</summary>
        public Rectangle BallBounds => new Rectangle(Left + margin, Top + margin, size, size);
        public int Margin2 => margin;

        void Kick() { if (!fx.Enabled) { lastT = clock.Elapsed.TotalSeconds; hasLast = false; fx.Start(); } }

        void StepFx()
        {
            double now = clock.Elapsed.TotalSeconds;
            float dt = (float)Math.Min(0.05, Math.Max(0.001, now - lastT));
            lastT = now;

            // drag velocity from actual window movement
            var pos = new PointF(Left, Top);
            if (hasLast && down && dragged)
            {
                float vx = (pos.X - lastPos.X) / dt, vy = (pos.Y - lastPos.Y) / dt;
                velX = velX * 0.55f + vx * 0.45f; velY = velY * 0.55f + vy * 0.45f;
            }
            else { velX *= 0.6f; velY *= 0.6f; }
            lastPos = pos; hasLast = true;

            float speed = (float)Math.Sqrt(velX * velX + velY * velY);
            if (speed > 60) dirAngle = (float)(Math.Atan2(velY, velX) * 180 / Math.PI);
            float stretchTarget = down && dragged ? Math.Min(0.42f, speed / (size * 55f)) : 0f;

            // springs: stretch is a little wobbly (jelly), scale snaps back with a small overshoot
            stretchV += (260f * (stretchTarget - stretch) - 11f * stretchV) * dt;
            stretch += stretchV * dt;
            scaleV += (700f * (scaleTarget - scale) - 20f * scaleV) * dt;
            scale += scaleV * dt;

            bool settled = !down && Math.Abs(stretch) < 0.002f && Math.Abs(stretchV) < 0.02f
                        && Math.Abs(scale - scaleTarget) < 0.002f && Math.Abs(scaleV) < 0.02f;
            if (settled) { stretch = 0; stretchV = 0; scale = scaleTarget; scaleV = 0; fx.Stop(); }
            Render();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) { down = true; dragged = false; downScreen = Cursor.Position; downLoc = Location; scaleTarget = 0.86f; Kick(); }
            base.OnMouseDown(e);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (down)
            {
                var p = Cursor.Position;
                int dx = p.X - downScreen.X, dy = p.Y - downScreen.Y;
                if (!dragged && Math.Abs(dx) + Math.Abs(dy) > 4) { dragged = true; scaleTarget = 1f; }
                if (dragged) Location = new Point(downLoc.X + dx, downLoc.Y + dy);
            }
            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && down)
            {
                down = false;
                scaleTarget = 1f;
                if (!dragged) scaleV += 2.5f;   // a little extra pop on click
                Kick();
                if (dragged) { SnapToScreen(); Moved?.Invoke(); }
                else Clicked?.Invoke();
            }
            else if (e.Button == MouseButtons.Right) RightClicked?.Invoke(Cursor.Position);
            base.OnMouseUp(e);
        }

        public void SnapToScreen()
        {
            var wa = Screen.FromPoint(new Point(Left + Width / 2, Top + Height / 2)).WorkingArea;
            // work in ball coordinates (window minus the transparent margin)
            int x = Math.Max(wa.Left, Math.Min(Left + margin, wa.Right - size));
            int y = Math.Max(wa.Top, Math.Min(Top + margin, wa.Bottom - size));
            // stick to the nearest side edge when close
            if (x - wa.Left < Scale(24)) x = wa.Left + Scale(4);
            if (wa.Right - (x + size) < Scale(24)) x = wa.Right - size - Scale(4);
            Location = new Point(x - margin, y - margin);
        }

        void Render()
        {
            if (!IsHandleCreated) return;
            using (var canvas = new Bitmap(size + margin * 2, size + margin * 2, PixelFormat.Format32bppArgb))
            using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    float pad = (float)Math.Round(size * 0.06f), d = size - pad * 2;
                    var rc = new RectangleF(pad, pad, d, d);

                    float cx = size / 2f;
                    if (skinImg != null)
                    {
                        using (var sh = new SolidBrush(Color.FromArgb(hover ? 60 : 35, 0, 0, 0)))
                            g.FillEllipse(sh, rc.X + 1, rc.Y + 2, rc.Width, rc.Height);
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        var ia = new ImageAttributes();
                        ia.SetWrapMode(WrapMode.TileFlipXY);
                        if (state == State.Off)
                        {
                            // greyed, slightly transparent when stopped
                            float r = 0.3f, gg = 0.59f, bl = 0.11f;
                            ia.SetColorMatrix(new ColorMatrix(new[] {
                                new[]{ r, r, r, 0f, 0f }, new[]{ gg, gg, gg, 0f, 0f }, new[]{ bl, bl, bl, 0f, 0f },
                                new[]{ 0f, 0f, 0f, 0.75f, 0f }, new[]{ 0f, 0f, 0f, 0f, 1f } }));
                        }
                        g.DrawImage(skinImg, new Rectangle((int)Math.Round(rc.X), (int)Math.Round(rc.Y), (int)Math.Round(rc.Width), (int)Math.Round(rc.Height)),
                            0, 0, skinImg.Width, skinImg.Height, GraphicsUnit.Pixel, ia);
                        ia.Dispose();
                    }
                    else
                    {
                        // soft shadow
                        using (var sh = new SolidBrush(Color.FromArgb(hover ? 70 : 45, 0, 0, 0)))
                            g.FillEllipse(sh, rc.X + 1, rc.Y + 2, rc.Width, rc.Height);

                        // body gradient
                        using (var br = new LinearGradientBrush(rc, Color.FromArgb(0x6D, 0x5B, 0xFF), Color.FromArgb(0x18, 0xB6, 0xE8), 45f))
                            g.FillEllipse(br, rc);
                        if (state == State.Off)
                            using (var dim = new SolidBrush(Color.FromArgb(90, 40, 40, 50))) g.FillEllipse(dim, rc);

                        // bridge glyph
                        float w = d * 0.56f, baseY = pad + d * 0.64f, top = pad + d * 0.34f;
                        using (var pen = new Pen(Color.White, Math.Max(2f, size * 0.055f)) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                        {
                            var path = new GraphicsPath();
                            path.AddBezier(cx - w / 2, baseY, cx - w / 4, top - d * 0.04f, cx + w / 4, top - d * 0.04f, cx + w / 2, baseY);
                            g.DrawPath(pen, path);
                            g.DrawLine(pen, cx - w / 2 - d * 0.04f, baseY, cx + w / 2 + d * 0.04f, baseY);
                            pen.Width = Math.Max(1.5f, size * 0.035f);
                            g.DrawLine(pen, cx, baseY, cx, top + d * 0.03f);
                            g.DrawLine(pen, cx - w * 0.27f, baseY, cx - w * 0.27f, top + d * 0.12f);
                            g.DrawLine(pen, cx + w * 0.27f, baseY, cx + w * 0.27f, top + d * 0.12f);
                        }
                        // star
                        DrawStar(g, cx, pad + d * 0.22f, d * 0.09f, Color.FromArgb(0xFF, 0xD8, 0x4D));


                    }

                    // status ring
                    Color ring = state == State.On ? Color.FromArgb(0x3F, 0xB9, 0x50)
                               : state == State.Starting ? Color.FromArgb(0xF0, 0xB4, 0x29)
                               : state == State.Error ? Color.FromArgb(0xF8, 0x51, 0x49)
                               : Color.FromArgb(0x9A, 0xA0, 0xA6);
                    float rw = Math.Max(2f, size * (skinImg != null ? 0.04f : 0.05f));
                    var rr = RectangleF.Inflate(rc, -rw / 2, -rw / 2);
                    using (var pen = new Pen(ring, rw))
                    {
                        if (state == State.Starting) g.DrawArc(pen, rr, spin, 250);
                        else g.DrawEllipse(pen, rr);
                    }
                    if (attention)
                    {
                        float a = (float)(0.5 + 0.5 * Math.Sin(spin * Math.PI / 90));
                        using (var b = new SolidBrush(Color.FromArgb((int)(120 + 135 * a), 0xF8, 0x51, 0x49)))
                            g.FillEllipse(b, size - pad - d * 0.30f, pad, d * 0.28f, d * 0.28f);
                    }
                }
                using (var cg = Graphics.FromImage(canvas))
                {
                    cg.Clear(Color.Transparent);
                    cg.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    cg.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    float c = margin + size / 2f;
                    if (Math.Abs(stretch) < 0.001f && Math.Abs(scale - 1f) < 0.001f)
                        cg.DrawImageUnscaled(bmp, margin, margin);
                    else
                    {
                        // water drop: longer along the motion, thinner across it, and lagging a bit behind
                        float sx = scale * (1f + stretch), sy = scale / (1f + stretch * 0.75f);
                        double rad = dirAngle * Math.PI / 180;
                        float lag = -stretch * size * 0.18f;
                        cg.TranslateTransform(c + (float)Math.Cos(rad) * lag, c + (float)Math.Sin(rad) * lag);
                        cg.RotateTransform(dirAngle);
                        cg.ScaleTransform(sx, sy);
                        cg.RotateTransform(-dirAngle);
                        cg.DrawImage(bmp, -size / 2f, -size / 2f, size, size);
                    }
                }
                Apply(canvas);
            }
        }

        static void DrawStar(Graphics g, float cx, float cy, float r, Color c)
        {
            var pts = new PointF[10];
            for (int i = 0; i < 10; i++)
            {
                double ang = -Math.PI / 2 + i * Math.PI / 5;
                float rad = i % 2 == 0 ? r : r * 0.45f;
                pts[i] = new PointF(cx + (float)(Math.Cos(ang) * rad), cy + (float)(Math.Sin(ang) * rad));
            }
            using (var b = new SolidBrush(c)) g.FillPolygon(b, pts);
        }

        void Apply(Bitmap bmp)
        {
            IntPtr screenDc = GetDC(IntPtr.Zero), memDc = CreateCompatibleDC(screenDc), hBmp = IntPtr.Zero, old = IntPtr.Zero;
            try
            {
                hBmp = bmp.GetHbitmap(Color.FromArgb(0));
                old = SelectObject(memDc, hBmp);
                var sz = new SIZE { cx = bmp.Width, cy = bmp.Height };
                var src = new POINT { x = 0, y = 0 };
                var pos = new POINT { x = Left, y = Top };
                var blend = new BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
                UpdateLayeredWindow(Handle, screenDc, ref pos, ref sz, memDc, ref src, 0, ref blend, 2 /*ULW_ALPHA*/);
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, screenDc);
                if (hBmp != IntPtr.Zero) { SelectObject(memDc, old); DeleteObject(hBmp); }
                DeleteDC(memDc);
            }
        }

        [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
        [DllImport("user32.dll", SetLastError = true)] static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pprSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hDC);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr hObject);
    }
}
