// Water Station enclosure for ESP32 NodeMCU-32S expansion shield
// + TDS meter and Turbidity adapter auxiliary boards.
//
// Orientation: X = length (left/right), Y = width (front/back),
// Z = height. "Left wall" = x=0 face (power entry).
// "Front wall" = y=0 face (probe cable exits toward the water).
//
// Lid is removable with 4x M3 screws (see lid_boss_positions) --
// undo the screws to open, no prying required.

// ---- Required top-level parameters ----
case_length    = 110;
case_width     = 85;
case_height    = 45;
wall_thickness = 2.5;

// ---- Main shield mounting (NodeMCU-32S expansion shield, 65x55mm) ----
shield_length      = 65;
shield_width       = 55;
pillar_spacing_x    = 60;  // mounting hole spacing, length direction
pillar_spacing_y    = 50;  // mounting hole spacing, width direction
pillar_outer_d      = 6.5;
pillar_hole_d       = 2.8; // M3 self-tap pilot hole
pillar_height       = 6;   // standoff height above the floor

// bottom-left corner of the shield footprint inside the case
shield_origin_x = 7.5;
shield_origin_y = 15;

// ---- Auxiliary board support pads (TDS meter, Turbidity adapter) ----
aux_board_length  = 30;
aux_board_width   = 20;
aux_standoff_d    = 5;
aux_standoff_h    = 4;
aux_standoff_hole_d = 2.5;
aux_corner_inset  = 3;

aux1_origin = [75, 10]; // TDS meter board area
aux2_origin = [75, 50]; // Turbidity adapter board area

// ---- Left wall power cutouts ----
usb_cutout_w   = 15; // along Y
usb_cutout_h   = 10; // along Z
usb_cutout_pos = [25, 14]; // [y, z] center on the left wall

barrel_hole_d   = 12;
barrel_hole_pos = [45, 14]; // [y, z] center on the left wall

// ---- Front wall probe cable exits ----
probe_hole_d      = 6;
probe_hole_z      = 10;
probe_hole_x_list = [25, 55, 85]; // TDS, Turbidity, DS18B20

// ---- Lid: screw-down mounting ----
lid_thickness       = wall_thickness;
boss_inset          = 6;    // distance from inner wall face to boss center
lid_screw_boss_d    = 7;
lid_screw_pilot_d   = 2.8;  // M3 self-tap pilot hole in the boss
lid_screw_pilot_depth = 8;
lid_screw_clearance_d = 3.4; // M3 shank clearance through the lid
lid_screw_head_d    = 6;    // counterbore for a flush screw head
lid_screw_head_depth = 2.2;

// bosses sit at the midpoint of each wall, clear of the pillars and aux pads
lid_boss_positions = [
    [case_length / 2, wall_thickness + boss_inset],
    [case_length / 2, case_width - wall_thickness - boss_inset],
    [wall_thickness + boss_inset, case_width / 2],
    [case_length - wall_thickness - boss_inset, case_width / 2],
];

// ---- Lid: alignment lip (locates the lid, no snap/interference fit) ----
alignment_lip_height = 3;
alignment_clearance  = 0.4; // per-side gap so the lip drops in freely

// ---- Lid: ventilation ----
vent_slit_w     = 1.5;
vent_slit_l     = 15;
vent_slit_count = 5;
vent_slit_gap   = 3;
vent_cluster_x  = shield_origin_x + shield_length / 2;
vent_cluster_y  = case_width / 2;

$fn = 48;

// ================= Case body =================

module pillar(x, y) {
    translate([x, y, wall_thickness])
        difference() {
            cylinder(d = pillar_outer_d, h = pillar_height);
            translate([0, 0, -0.5])
                cylinder(d = pillar_hole_d, h = pillar_height + 1);
        }
}

module main_pillars() {
    pillar(shield_origin_x + (shield_length - pillar_spacing_x) / 2,
           shield_origin_y + (shield_width - pillar_spacing_y) / 2);
    pillar(shield_origin_x + (shield_length - pillar_spacing_x) / 2 + pillar_spacing_x,
           shield_origin_y + (shield_width - pillar_spacing_y) / 2);
    pillar(shield_origin_x + (shield_length - pillar_spacing_x) / 2,
           shield_origin_y + (shield_width - pillar_spacing_y) / 2 + pillar_spacing_y);
    pillar(shield_origin_x + (shield_length - pillar_spacing_x) / 2 + pillar_spacing_x,
           shield_origin_y + (shield_width - pillar_spacing_y) / 2 + pillar_spacing_y);
}

module aux_standoff(x, y) {
    translate([x, y, wall_thickness])
        difference() {
            cylinder(d = aux_standoff_d, h = aux_standoff_h);
            translate([0, 0, -0.5])
                cylinder(d = aux_standoff_hole_d, h = aux_standoff_h + 1);
        }
}

module aux_board_area(origin) {
    bx = origin[0];
    by = origin[1];
    aux_standoff(bx + aux_corner_inset, by + aux_corner_inset);
    aux_standoff(bx + aux_board_length - aux_corner_inset, by + aux_corner_inset);
    aux_standoff(bx + aux_corner_inset, by + aux_board_width - aux_corner_inset);
    aux_standoff(bx + aux_board_length - aux_corner_inset, by + aux_board_width - aux_corner_inset);
}

module aux_pillars() {
    aux_board_area(aux1_origin);
    aux_board_area(aux2_origin);
}

module left_wall_cutouts() {
    // USB / power cable opening (cut fully through the wall)
    translate([0, usb_cutout_pos[0], usb_cutout_pos[1]])
        cube([wall_thickness * 4, usb_cutout_w, usb_cutout_h], center = true);
    // DC barrel jack hole
    translate([0, barrel_hole_pos[0], barrel_hole_pos[1]])
        rotate([0, 90, 0])
            cylinder(d = barrel_hole_d, h = wall_thickness * 4, center = true);
}

module front_wall_probe_holes() {
    for (x = probe_hole_x_list) {
        translate([x, 0, probe_hole_z])
            rotate([90, 0, 0])
                cylinder(d = probe_hole_d, h = wall_thickness * 4, center = true);
    }
}

module lid_screw_boss(x, y) {
    boss_h = case_height - wall_thickness;
    translate([x, y, wall_thickness])
        difference() {
            cylinder(d = lid_screw_boss_d, h = boss_h);
            translate([0, 0, boss_h - lid_screw_pilot_depth])
                cylinder(d = lid_screw_pilot_d, h = lid_screw_pilot_depth + 0.5);
        }
}

module lid_screw_bosses() {
    for (p = lid_boss_positions) lid_screw_boss(p[0], p[1]);
}

module case_shell() {
    difference() {
        cube([case_length, case_width, case_height]);
        // hollow interior, open top
        translate([wall_thickness, wall_thickness, wall_thickness])
            cube([case_length - 2 * wall_thickness,
                  case_width - 2 * wall_thickness,
                  case_height]);
        left_wall_cutouts();
        front_wall_probe_holes();
    }
}

module water_station_case() {
    union() {
        case_shell();
        main_pillars();
        aux_pillars();
        lid_screw_bosses();
    }
}

// ================= Lid =================

module vent_slits() {
    total_w = vent_slit_count * vent_slit_w + (vent_slit_count - 1) * vent_slit_gap;
    start_x = vent_cluster_x - total_w / 2;
    for (i = [0 : vent_slit_count - 1]) {
        translate([start_x + i * (vent_slit_w + vent_slit_gap),
                   vent_cluster_y - vent_slit_l / 2,
                   -0.5])
            cube([vent_slit_w, vent_slit_l, lid_thickness + 1]);
    }
}

module lid_screw_holes() {
    for (p = lid_boss_positions) {
        // clearance hole through the whole plate
        translate([p[0], p[1], case_height - 0.5])
            cylinder(d = lid_screw_clearance_d, h = lid_thickness + 1);
        // counterbore so the screw head sits flush with the top face
        translate([p[0], p[1], case_height + lid_thickness - lid_screw_head_depth])
            cylinder(d = lid_screw_head_d, h = lid_screw_head_depth + 0.5);
    }
}

module lid() {
    difference() {
        union() {
            // top plate, sits on the case's wall rim
            translate([0, 0, case_height])
                cube([case_length, case_width, lid_thickness]);
            // shallow alignment lip -- locates the lid, no interference fit,
            // just keeps it from sliding around before the screws go in
            translate([wall_thickness + alignment_clearance,
                       wall_thickness + alignment_clearance,
                       case_height - alignment_lip_height])
                cube([case_length - 2 * (wall_thickness + alignment_clearance),
                      case_width - 2 * (wall_thickness + alignment_clearance),
                      alignment_lip_height]);
        }
        vent_slits();
        lid_screw_holes();
    }
}

// ================= Assembly =================
// Set lid_exploded_offset to 0 to preview assembled, or raise it
// to separate the parts (e.g. for arranging on the print bed).
lid_exploded_offset = 60;
show_lid = true;

water_station_case();
if (show_lid) {
    translate([0, 0, lid_exploded_offset])
        lid();
}
