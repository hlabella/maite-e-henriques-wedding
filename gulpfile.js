const gulp = require('gulp');
const sass = require('gulp-sass')(require('sass'));
const uglify = require('gulp-uglify');
const rename = require('gulp-rename');
const babel = require('gulp-babel');

// Compile SCSS to CSS
gulp.task('sass', function () {
    return gulp.src('./sass/styles.scss')
        .pipe(sass({ outputStyle: 'compressed' }).on('error', sass.logError))
        .pipe(rename({ basename: 'styles.min' }))
        .pipe(gulp.dest('./css'));
});

// Transpile and Minify JS
gulp.task('minify-js', function () {
    return gulp.src('./js/scripts.js')
        .pipe(babel({
            presets: ['@babel/preset-env']
        }))
        .pipe(uglify())
        .pipe(rename({ basename: 'scripts.min' }))
        .pipe(gulp.dest('./js'));
});

// Default task
gulp.task('default', gulp.series('sass', 'minify-js'));
