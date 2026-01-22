/**
 * Animation presets for @vueuse/motion
 * Provides consistent animations across the app
 */
export function useAnimationPresets() {
  /**
   * Fade in and slide up animation
   * @param delay - Delay in milliseconds before animation starts
   */
  const fadeSlideUp = (delay = 0) => ({
    initial: { opacity: 0, y: 20 },
    enter: {
      opacity: 1,
      y: 0,
      transition: {
        delay,
        duration: 400,
        ease: 'easeOut',
      },
    },
  });

  /**
   * Fade in with scale animation
   * @param delay - Delay in milliseconds before animation starts
   */
  const fadeScale = (delay = 0) => ({
    initial: { opacity: 0, scale: 0.8 },
    enter: {
      opacity: 1,
      scale: 1,
      transition: {
        delay,
        duration: 600,
        ease: 'easeOut',
      },
    },
  });

  /**
   * Slide in from left
   * @param delay - Delay in milliseconds before animation starts
   */
  const slideInLeft = (delay = 0) => ({
    initial: { opacity: 0, x: -20 },
    enter: {
      opacity: 1,
      x: 0,
      transition: {
        delay,
        duration: 400,
        ease: 'easeOut',
      },
    },
  });

  /**
   * Creates staggered animation delays for child elements
   * @param baseDelay - Initial delay before first item
   * @param perItem - Delay increment per item
   */
  const staggerChildren = (baseDelay = 100, perItem = 100) => {
    return (index: number) => fadeSlideUp(baseDelay + index * perItem);
  };

  /**
   * Logo wobble animation for splash screen
   */
  const logoWobble = {
    enter: {
      rotate: [0, 5, -5, 0],
      scale: [1, 1.05, 1],
      transition: {
        duration: 3000,
        repeat: Infinity,
        ease: 'easeInOut',
      },
    },
  };

  /**
   * Rotating animation for loading indicators
   */
  const rotate = {
    enter: {
      rotate: 360,
      transition: {
        duration: 2000,
        repeat: Infinity,
        ease: 'linear',
      },
    },
  };

  /**
   * Pulse animation for status indicators
   */
  const pulse = {
    enter: {
      scale: [1, 1.1, 1],
      opacity: [1, 0.8, 1],
      transition: {
        duration: 2000,
        repeat: Infinity,
        ease: 'easeInOut',
      },
    },
  };

  /**
   * Dot loading animation
   * @param index - Index of the dot (0, 1, 2)
   */
  const loadingDot = (index: number) => ({
    enter: {
      opacity: [0.3, 1, 0.3],
      transition: {
        duration: 1500,
        repeat: Infinity,
        delay: index * 200,
        ease: 'easeInOut',
      },
    },
  });

  /**
   * Spring bounce animation for success states
   */
  const springBounce = {
    initial: { scale: 0 },
    enter: {
      scale: 1,
      transition: {
        type: 'spring',
        stiffness: 200,
        damping: 15,
      },
    },
  };

  /**
   * Background pulse for decorative elements
   */
  const backgroundPulse = {
    enter: {
      scale: [1, 1.2, 1],
      opacity: [0.1, 0.2, 0.1],
      transition: {
        duration: 4000,
        repeat: Infinity,
        ease: 'easeInOut',
      },
    },
  };

  /**
   * Progress bar animation
   */
  const progressBar = {
    initial: { width: '0%' },
    enter: {
      width: '100%',
      transition: {
        duration: 2000,
        repeat: Infinity,
        ease: 'easeInOut',
      },
    },
  };

  return {
    fadeSlideUp,
    fadeScale,
    slideInLeft,
    staggerChildren,
    logoWobble,
    rotate,
    pulse,
    loadingDot,
    springBounce,
    backgroundPulse,
    progressBar,
  };
}
