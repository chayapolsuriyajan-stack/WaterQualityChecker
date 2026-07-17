// Parametric ESP32 enclosure

inner_length = 70;
inner_width = 50;
inner_height = 30;
wall_thickness = 2;

outer_length = inner_length + 2 * wall_thickness;
outer_width = inner_width + 2 * wall_thickness;
outer_height = inner_height + 2 * wall_thickness;

module case() {
    difference() {
        cube([outer_length, outer_width, outer_height]);
        translate([wall_thickness, wall_thickness, wall_thickness])
            cube([inner_length, inner_width, inner_height]);
    }
}

case();
